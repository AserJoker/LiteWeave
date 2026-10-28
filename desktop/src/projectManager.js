/**
 * 项目管理器 —— 受管理工作区（~/.liteweave/projects/）的增删改查 + 导入/导出。
 *
 * 设计（用户定案）：
 * - 项目不再指向任意磁盘目录，全部收拢到 ~/.liteweave 家目录下的 projects/ 子目录
 * - 项目目录命名 <name>-<shortId>（如 MyGame-a3f9），project.json 存显示名与元数据
 * - 导入/导出用 zip 压缩包，重命名为 .liteweave 后缀（magic bytes PK\x03\x04 校验）
 * - 彻底移除“打开任意磁盘目录”能力
 *
 * 依赖：adm-zip（纯 JS，无原生依赖）。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import AdmZip from 'adm-zip'

/** 默认家目录根（~/.liteweave） */
const DEFAULT_HOME = path.join(os.homedir(), '.liteweave')
/** 导出包后缀 */
export const PROJECT_PACKAGE_EXT = '.liteweave'
/** project.json 文件名 */
export const PROJECT_META_FILE = 'project.json'
/** 当前格式版本（导入时校验；v2 = 资源协议：type/命名空间/资源清单） */
export const FORMAT_VERSION = 2

/** 项目类型（全局配置；影响可创建资源的类型过滤） */
export const PROJECT_TYPES = ['2d', '3d']
/** 默认项目类型 */
export const DEFAULT_PROJECT_TYPE = '2d'
/** 资源目录名（命名空间 = 顶层目录） */
export const ASSETS_DIR = 'assets'

/** 命名空间合法字符（^[a-zA-Z][a-zA-Z0-9_]*$） */
const NS_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/

/** 资源类型按文件后缀推断（资源协议 v2 §2.3：后缀决定解析格式） */
const RESOURCE_TYPE_BY_EXT = {
  '.lang': 'i18n',
  '.scene': 'scene',
  '.sprite': 'sprite',
  '.png': 'sprite',
  '.jpg': 'sprite',
  '.fx': 'fx',
  '.prefab': 'prefab',
  '.model': 'model',
  '.mesh': 'mesh',
  '.material': 'material',
  '.tilemap': 'tilemap',
  '.sound': 'sound',
  '.ogg': 'sound',
  '.mp3': 'sound',
  '.wav': 'sound',
}

/** 按文件名后缀推断资源类型；未知后缀回退 'asset' */
function resourceTypeFromName(name) {
  const ext = path.extname(name).toLowerCase()
  return RESOURCE_TYPE_BY_EXT[ext] ?? 'asset'
}

/**
 * 磁盘文件锁：跨进程/多实例互斥。
 * 原理：fs.mkdir 对已存在目录抛 EEXIST（原子操作），目录创建成功即持有锁；
 * 释放时删除锁目录。进程崩溃残留的锁按 mtime 判定为 stale 后清除并重试。
 * 内存 promise 队列只对单实例有效，无法防止多个 Electron/Node 进程并发，
 * 因此 create 的幂等保护必须用磁盘锁（见 create）。
 * @param {string} lockPath 锁目录路径
 * @param {object} [options]
 * @param {number} [options.timeout] 等待上限（默认 30s）
 * @param {number} [options.staleMs] 超过该 mtime 视为 stale（默认 60s；create 毫秒级完成，足够宽松）
 * @param {number} [options.pollMs] 轮询间隔（默认 100ms）
 * @returns {Promise<() => Promise<void>>} release 函数
 */
async function acquireLock(lockPath, options = {}) {
  const { timeout = 30000, staleMs = 60000, pollMs = 100 } = options
  const deadline = Date.now() + timeout
  // 确保锁目录的父目录存在（家目录可能尚未初始化）
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  for (;;) {
    try {
      await fs.mkdir(lockPath)
      // 写入 owner 信息便于诊断；不参与锁判定
      await fs
        .writeFile(
          path.join(lockPath, 'owner.json'),
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
        )
        .catch(() => {})
      return async () => {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {})
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      // 锁被占用：检查是否 stale（进程崩溃残留），是则清除后重试
      const st = await fs.stat(lockPath).catch(() => null)
      if (st && Date.now() - st.mtimeMs > staleMs) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {})
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(`获取创建锁超时（${timeout}ms），可能有其他实例正在创建项目`)
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }
}

/** 项目名 → 默认命名空间（小写化 + 非法字符去化；空/全非法回退 'main'） */
function defaultNamespaceFromName(name) {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
  return base.length > 0 && /^[a-zA-Z]/.test(base) ? base : 'main'
}

/** 校验命名空间；非法抛错 */
function validateNamespace(ns) {
  if (typeof ns !== 'string' || !NS_RE.test(ns)) {
    throw new Error(`命名空间不合法（须字母开头，仅含字母/数字/下划线）: ${ns}`)
  }
  return ns
}

/** 分域整体参数默认骨架（rendering/input/physics/build 各域独立演进） */
function defaultSettings() {
  return { rendering: {}, input: {}, physics: {}, build: {} }
}

/** 默认语言列表（项目可声明语言；.lang 资源按 id 命名 <id>.lang） */
function defaultLanguages() {
  return [{ id: 'zh_CN', display_name: '简体中文' }]
}

/** 补齐 v2 协议缺失字段（v1 → v2 迁移；type/命名空间/清单/入口） */
function ensureV2Fields(meta) {
  const m = { ...meta }
  const name = typeof m.name === 'string' ? m.name : 'Project'
  if (!PROJECT_TYPES.includes(m.type)) m.type = DEFAULT_PROJECT_TYPE
  if (!Array.isArray(m.namespaces) || m.namespaces.length === 0) {
    m.namespaces = [defaultNamespaceFromName(name)]
  }
  if (typeof m.defaultNamespace !== 'string' || !m.namespaces.includes(m.defaultNamespace)) {
    m.defaultNamespace = m.namespaces[0]
  }
  if (!m.settings || typeof m.settings !== 'object') m.settings = defaultSettings()
  if (typeof m.entry !== 'string' || !m.entry.includes(':')) {
    m.entry = `${m.defaultNamespace}:scenes/main.scene`
  }
  if (!Array.isArray(m.resources)) m.resources = []
  if (!Array.isArray(m.languages) || m.languages.length === 0) m.languages = defaultLanguages()
  return m
}

/** 生成短 ID：4 位 base36 随机 */
function shortId() {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0')
}

/** 目录名 → 显示名（去掉 -<shortId> 后缀） */
function displayNameFromDir(dirName) {
  return dirName.replace(/-[0-9a-z]{4}$/, '')
}

/** 读取 project.json，失败返回 null */
async function readMeta(projectDir) {
  try {
    const raw = await fs.readFile(path.join(projectDir, PROJECT_META_FILE), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 目录内递归打包（adm-zip addLocalFolder） */
function zipProject(projectDir) {
  const zip = new AdmZip()
  // 参数 2 为相对路径映射：包内条目相对项目根
  zip.addLocalFolder(projectDir, '')
  return zip
}

/**
 * 项目元数据（与前端 ProjectMeta 对齐）。
 * @typedef {object} ProjectMeta
 * @property {string} id 短 ID
 * @property {string} name 显示名
 * @property {string} dirName 项目目录名（name-id）
 * @property {string} path 项目目录绝对路径
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {number} formatVersion
 * @property {'2d'|'3d'} type 项目类型（全局配置）
 * @property {string} defaultNamespace 默认命名空间
 * @property {string[]} namespaces 全部命名空间（≥1）
 * @property {object} settings 分域整体参数
 * @property {string} entry 引擎启动入口（资源 id）
 * @property {Array} resources 资源清单
 * @property {Array<{id: string, display_name: string}>} languages 项目语言列表（.lang 资源按 id 命名）
 */

/** 磁盘 meta → 前端 ProjectMeta（补 v2 字段 + 目录信息） */
function toProject(meta, projectDir) {
  const v2 = ensureV2Fields(meta)
  return {
    id: v2.id,
    name: v2.name ?? displayNameFromDir(path.basename(projectDir)),
    dirName: path.basename(projectDir),
    path: projectDir,
    createdAt: v2.createdAt ?? '',
    updatedAt: v2.updatedAt ?? '',
    formatVersion: v2.formatVersion ?? FORMAT_VERSION,
    type: v2.type,
    defaultNamespace: v2.defaultNamespace,
    namespaces: v2.namespaces,
    settings: v2.settings,
    entry: v2.entry,
    entryScript: v2.entryScript,
    resources: v2.resources,
    languages: v2.languages,
  }
}

/**
 * 创建项目管理器。
 * @param {object} [options]
 * @param {string} [options.homeDir] 家目录根（默认 ~/.liteweave；测试可注入临时目录）
 */
export function createProjectManager(options = {}) {
  const HOME_DIR = options.homeDir ?? DEFAULT_HOME
  const PROJECTS_DIR = path.join(HOME_DIR, 'projects')

  /** 确保家目录与项目目录存在 */
  async function ensureHome() {
    await fs.mkdir(PROJECTS_DIR, { recursive: true })
  }

  /** 家目录绝对路径（供 settings 迁移用） */
  function homeDir() {
    return HOME_DIR
  }

  /** 扫描项目列表（读每个子目录的 project.json） */
  async function list() {
    await ensureHome()
    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true })
    const projects = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const projectDir = path.join(PROJECTS_DIR, entry.name)
      const meta = await readMeta(projectDir)
      if (!meta) continue
      projects.push(toProject(meta, projectDir))
    }
    // 按更新时间倒序
    projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return { projects }
  }

  /** 校验项目名：非空、不含非法字符 */
  function validateName(name) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('项目名不能为空')
    }
    const trimmed = name.trim()
    if (/[\\/:*?"<>|]/.test(trimmed)) {
      throw new Error('项目名包含非法字符')
    }
    return trimmed
  }

  /** 创建项目目录（不重名时用原名；撞名则追加短 ID）。返回 { projectDir, dirName, renamed } */
  async function createProjectDir(name, id) {
    await ensureHome()
    let dirName = `${name}-${id}`
    let projectDir = path.join(PROJECTS_DIR, dirName)
    let i = 1
    while (true) {
      try {
        await fs.mkdir(projectDir, { recursive: false })
        return { projectDir, dirName, renamed: i > 1 }
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
        // 撞名：追加后缀
        dirName = `${name}-${id}-${i++}`
        projectDir = path.join(PROJECTS_DIR, dirName)
      }
    }
  }

  /** 创建项目：校验名称 → 建目录 → 建命名空间骨架 → 写 project.json v2 */
  async function create({ name, type, defaultNamespace }) {
    // 跨进程/多实例互斥：磁盘文件锁（fs.mkdir 原子性），锁内做幂等检查 + 创建，
    // 避免多个 Electron 实例并发的同名创建竞态（TOCTOU）。锁释放后锁目录删除。
    const lockPath = path.join(HOME_DIR, '.create.lock')
    const release = await acquireLock(lockPath)
    try {
      const cleanName = validateName(name)
      // 幂等保护：同名项目已存在时复用（返回已有），避免 MCP/Agent 重试导致重复创建
      const existing = await findDirByName(cleanName)
      if (existing) {
        return { project: toProject(existing.meta, existing.projectDir), reused: true }
      }
      // 项目类型：默认 2d；3d 项目开放 model/mesh/material 等资源类型（全局配置）
      const projectType = type === '3d' ? '3d' : DEFAULT_PROJECT_TYPE
      const ns = validateNamespace(defaultNamespace ?? defaultNamespaceFromName(cleanName))
      const id = shortId()
      const { projectDir } = await createProjectDir(cleanName, id)
      const now = new Date().toISOString()
      const meta = ensureV2Fields({
        name: cleanName,
        id,
        createdAt: now,
        updatedAt: now,
        formatVersion: FORMAT_VERSION,
        engineVersion: '0.1.0',
        type: projectType,
        defaultNamespace: ns,
        namespaces: [ns],
      })
      // 建命名空间目录（assets/<ns>/scenes/ 骨架；资源文件落 assets/<ns>/ 下）
      await fs.mkdir(path.join(projectDir, ASSETS_DIR, ns, 'scenes'), { recursive: true })
      await fs.writeFile(path.join(projectDir, PROJECT_META_FILE), JSON.stringify(meta, null, 2), 'utf8')
      return { project: toProject(meta, projectDir) }
    } finally {
      await release()
    }
  }

  /** 按 id 找项目目录（扫描 projects 下各子目录的 project.json） */
  async function findDirById(id) {
    await ensureHome()
    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const projectDir = path.join(PROJECTS_DIR, entry.name)
      const meta = await readMeta(projectDir)
      if (meta && meta.id === id) return { projectDir, meta }
    }
    return null
  }

  /** 按显示名找项目目录（幂等保护：同名项目已存在时复用，不重复创建） */
  async function findDirByName(name) {
    await ensureHome()
    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const projectDir = path.join(PROJECTS_DIR, entry.name)
      const meta = await readMeta(projectDir)
      if (meta && meta.name === name) return { projectDir, meta }
    }
    return null
  }

  /** 打开项目：按 id 返回元数据 + 目录树（readDirTree 由调用方注入） */
  async function open({ id, readDirTree }) {
    const found = await findDirById(id)
    if (!found) {
      return { canceled: false, error: `项目不存在: ${id}` }
    }
    const { projectDir, meta } = found
    const tree = await readDirTree(projectDir)
    return {
      canceled: false,
      project: toProject(meta, projectDir),
      tree,
    }
  }

  /* ---------------- 通用资源文件 CRUD（虚拟路径 → 磁盘，安全校验防穿越） ---------------- */

  /**
   * 虚拟路径解析：把资源虚拟路径（相对项目根，/ 分隔）解析为项目内绝对路径。
   * 安全：解析后必须仍在项目目录内（防 ../ 穿越），否则抛错。
   */
  async function resolveProjectPath(projectDir, virtualPath) {
    if (typeof virtualPath !== 'string' || !virtualPath) {
      throw new Error('资源路径不能为空')
    }
    const normalized = path.normalize(virtualPath.split('/').join(path.sep))
    const abs = path.resolve(projectDir, normalized)
    const root = path.resolve(projectDir)
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`资源路径越界: ${virtualPath}`)
    }
    return abs
  }

  /**
   * 计算虚拟路径的层级深度（按 / 分段）。
   * - 'assets' → 1
   * - 'assets/demo' → 2
   * - 'assets/demo/i18n' → 3
   * - 'assets/demo/i18n/sub' → 4
   * 空/根路径返回 0。
   */
  function getPathDepth(virtualPath) {
    if (typeof virtualPath !== 'string' || !virtualPath) return 0
    return virtualPath.split('/').filter(Boolean).length
  }

  /**
   * 创建目录（虚拟路径）。完全自由创建，不限层级，不校验命名空间。
   * 已存在返回 { ok:false, error:'目录已存在' }（幂等保护）。
   * 创建后刷新 project.json.updatedAt。返回 { ok:true }。
   * @param {object} args { id, path }
   */
  async function createDir({ id, path: virtualPath }) {
    const found = await findDirById(id)
    if (!found) throw new Error(`项目不存在: ${id}`)
    const { projectDir, meta } = found
    if (typeof virtualPath !== 'string' || !virtualPath) {
      return { ok: false, error: '目录路径不能为空' }
    }
    const depth = getPathDepth(virtualPath)
    if (depth < 1) {
      return { ok: false, error: '目录路径不合法' }
    }
    const abs = await resolveProjectPath(projectDir, virtualPath)
    // 幂等保护：已存在则返回错误
    try {
      await fs.access(abs)
      return { ok: false, error: '目录已存在' }
    } catch {
      // 不存在 → 继续创建
    }
    await fs.mkdir(abs, { recursive: true })
    meta.updatedAt = new Date().toISOString()
    await fs.writeFile(path.join(projectDir, PROJECT_META_FILE), JSON.stringify(meta, null, 2), 'utf8')
    return { ok: true }
  }

  /**
   * 重命名文件或目录（fs.rename 移动；同目录改名是 fs.rename 的特例）。
   * 同步 project.json 资源清单：文件 → 改 path；目录 → 改所有前缀匹配的资源 path。
   * 校验：源不存在/目标已存在/路径越界/根目录改名 → 返回 { ok:false, error }。
   * @param {object} args { id, oldPath, newPath }
   */
  async function rename({ id, oldPath, newPath }) {
    const found = await findDirById(id)
    if (!found) throw new Error(`项目不存在: ${id}`)
    const { projectDir, meta } = found
    if (typeof oldPath !== 'string' || !oldPath || typeof newPath !== 'string' || !newPath) {
      return { ok: false, error: '路径不能为空' }
    }
    if (getPathDepth(oldPath) < 1 || getPathDepth(newPath) < 1) {
      return { ok: false, error: '不能在项目根层级重命名' }
    }
    if (oldPath === newPath) return { ok: true }
    const srcAbs = await resolveProjectPath(projectDir, oldPath)
    const dstAbs = await resolveProjectPath(projectDir, newPath)
    // 源必须存在
    try {
      await fs.access(srcAbs)
    } catch {
      return { ok: false, error: '源路径不存在' }
    }
    // 目标必须不存在（避免覆盖）
    try {
      await fs.access(dstAbs)
      return { ok: false, error: '目标路径已存在' }
    } catch {
      // 不存在 → 继续
    }
    // 目标父目录必须存在（fs.rename 不自动创建父目录）
    await fs.mkdir(path.dirname(dstAbs), { recursive: true })
    await fs.rename(srcAbs, dstAbs)
    // 同步 project.json 资源清单
    const resources = Array.isArray(meta.resources) ? meta.resources : []
    const isSrcDir = (await fs.stat(dstAbs)).isDirectory()
    const updated = resources.map((r) => {
      if (isSrcDir) {
        // 目录：所有以 oldPath/ 开头的资源 path 替换前缀
        if (r.path === oldPath || r.path.startsWith(oldPath + '/')) {
          return { ...r, path: newPath + r.path.slice(oldPath.length) }
        }
        return r
      }
      // 文件：精确匹配
      if (r.path === oldPath) return { ...r, path: newPath }
      return r
    })
    meta.resources = updated
    meta.updatedAt = new Date().toISOString()
    await fs.writeFile(path.join(projectDir, PROJECT_META_FILE), JSON.stringify(meta, null, 2), 'utf8')
    return { ok: true }
  }

  /**
   * 删除目录（递归）。完全自由删除，任意 depth ≥ 1 的目录都可删（含 assets/）。
   * 递归删除整个目录树。不存在返回 { ok:false, error:'目录不存在' }（幂等）。
   * 删除后刷新 project.json.updatedAt。返回 { ok:true }。
   * @param {object} args { id, path }
   */
  async function deleteDir({ id, path: virtualPath }) {
    const found = await findDirById(id)
    if (!found) throw new Error(`项目不存在: ${id}`)
    const { projectDir, meta } = found
    if (typeof virtualPath !== 'string' || !virtualPath) {
      return { ok: false, error: '目录路径不能为空' }
    }
    const depth = getPathDepth(virtualPath)
    if (depth < 1) {
      return { ok: false, error: '不能删除项目根目录' }
    }
    const abs = await resolveProjectPath(projectDir, virtualPath)
    // Windows 下 fs.rm 删除含子项的目录可能因文件句柄释放延迟报 EPERM/ENOTEMPTY，
    // 短暂重试 + 最终 force 兜底，避免残留空壳目录。
    let lastErr = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await fs.rm(abs, { force: false, recursive: true })
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        if (err.code === 'ENOENT') return { ok: false, error: '目录不存在' }
        // EPERM/ENOTEMPTY：等一会再试
        await new Promise((r) => setTimeout(r, 60))
      }
    }
    if (lastErr) {
      // 最后一次 force 兜底（忽略不存在的子项）
      try {
        await fs.rm(abs, { force: true, recursive: true })
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }
    meta.updatedAt = new Date().toISOString()
    await fs.writeFile(path.join(projectDir, PROJECT_META_FILE), JSON.stringify(meta, null, 2), 'utf8')
    return { ok: true }
  }

  /**
   * 读取资源文件文本（UTF-8）。返回 { content }；文件不存在抛错。
   */
  async function readFile(id, virtualPath) {
    const found = await findDirById(id)
    if (!found) throw new Error(`项目不存在: ${id}`)
    const abs = await resolveProjectPath(found.projectDir, virtualPath)
    const content = await fs.readFile(abs, 'utf8')
    return { content }
  }

  /**
   * 写资源文件（创建或覆盖）。parent 目录不存在时自动创建；
   * 写文件后刷新 project.json 的 updatedAt。返回 { ok: true }。
   */
  async function writeFile(id, virtualPath, content) {
    const found = await findDirById(id)
    if (!found) throw new Error(`项目不存在: ${id}`)
    const abs = await resolveProjectPath(found.projectDir, virtualPath)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content ?? '', 'utf8')
    // 刷新 updatedAt（资源变更影响项目更新时间）
    found.meta.updatedAt = new Date().toISOString()
    await fs.writeFile(
      path.join(found.projectDir, PROJECT_META_FILE),
      JSON.stringify(found.meta, null, 2),
      'utf8',
    )
    return { ok: true }
  }

  /**
   * 创建资源文件：写入磁盘 + 同步资源清单（type 按后缀推断）。
   * 已存在则返回 { ok: false, error: '资源已存在' }（幂等保护：AI 重试不重复创建）。
   * @param {object} args { id, path, name, namespace }
   *   - id：项目 id
   *   - path：目标虚拟路径（相对项目根，如 assets/demo/i18n/zh_CN.lang）；缺省用 namespace+name 组装
   *   - name：文件名（如 zh_CN.lang），path 缺省时必需
   *   - namespace：命名空间（默认 defaultNamespace），path 缺省时用
   */
  async function createFile({ id, path: virtualPath, name, namespace, content }) {
    const found = await findDirById(id)
    if (!found) throw new Error(`项目不存在: ${id}`)
    const { projectDir, meta } = found
    // 目标路径：显式 path 优先；否则按 命名空间/name 组装到 assets/<ns>/ 下
    let relPath = virtualPath
    if (!relPath) {
      if (!name) throw new Error('创建资源需提供 path 或 name')
      const ns = namespace || meta.defaultNamespace || 'main'
      relPath = `${ASSETS_DIR}/${ns}/${name}`
    }
    const abs = await resolveProjectPath(projectDir, relPath)
    // 幂等保护：已存在则返回（AI/MCP 重试不重复创建）
    try {
      await fs.access(abs)
      return { ok: false, error: '资源已存在', resource: { id: `${meta.defaultNamespace}:${relPath}`, type: resourceTypeFromName(path.basename(relPath)), path: relPath } }
    } catch {
      // 不存在 → 继续创建
    }
    // .lang 语言文件校验：文件名 <语言id>.lang，语言 id 必须在项目 languages 声明内
    const type = resourceTypeFromName(path.basename(relPath))
    if (type === 'i18n') {
      const langId = path.basename(relPath, '.lang')
      const declared = Array.isArray(meta.languages) ? meta.languages.map((l) => l?.id) : []
      if (!declared.includes(langId)) {
        const names = declared.length > 0 ? declared.join(' / ') : '（未声明）'
        return { ok: false, error: `语言 "${langId}" 未在项目语言列表声明（已声明: ${names}）` }
      }
    }
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content ?? '', 'utf8')
    // 同步资源清单：追加条目
    const entry = { id: `${meta.defaultNamespace}:${relPath}`, type, path: relPath }
    const resources = Array.isArray(meta.resources) ? [...meta.resources] : []
    if (!resources.some((r) => r.path === relPath)) {
      resources.push(entry)
    }
    meta.resources = resources
    meta.updatedAt = new Date().toISOString()
    await fs.writeFile(path.join(projectDir, PROJECT_META_FILE), JSON.stringify(meta, null, 2), 'utf8')
    return { ok: true, resource: entry }
  }

  /**
   * 删除资源文件：删除磁盘文件 + 从资源清单移除。
   * 文件不存在返回 { ok: false, error: '资源不存在' }（幂等）。返回 { ok: true }。
   */
  async function deleteFile(id, virtualPath) {
    const found = await findDirById(id)
    if (!found) throw new Error(`项目不存在: ${id}`)
    const { projectDir, meta } = found
    const abs = await resolveProjectPath(projectDir, virtualPath)
    try {
      await fs.rm(abs, { force: false })
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: false, error: '资源不存在' }
      throw err
    }
    // 同步资源清单：移除对应条目
    const resources = Array.isArray(meta.resources) ? meta.resources.filter((r) => r.path !== virtualPath) : []
    meta.resources = resources
    meta.updatedAt = new Date().toISOString()
    await fs.writeFile(path.join(projectDir, PROJECT_META_FILE), JSON.stringify(meta, null, 2), 'utf8')
    return { ok: true }
  }

  /** 导入 .liteweave 包：选文件 → 校验 zip → 解压到 projects/ */
  async function importPackage(filePath) {
    const buffer = await fs.readFile(filePath)
    // 校验 zip magic bytes（PK\x03\x04）
    const isZip =
      buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04
    if (!isZip) {
      throw new Error('不是有效的 LiteWeave 项目包（.liteweave）')
    }
    const zip = new AdmZip(buffer)
    // 包内应含 project.json（项目根镜像）
    const metaEntry = zip.getEntry(PROJECT_META_FILE)
    if (!metaEntry) {
      throw new Error('项目包缺少 project.json，无法导入')
    }
    let meta
    try {
      meta = JSON.parse(metaEntry.getData().toString('utf8'))
    } catch {
      throw new Error('项目包 project.json 解析失败')
    }
    const id = meta.id && /^[0-9a-z]{4}$/.test(meta.id) ? meta.id : shortId()
    const name = validateName(meta.name ?? 'ImportedProject')
    const { projectDir, renamed } = await createProjectDir(name, id)
    // 撞名时（目录名被追加后缀）重新生成 id 写入，保证 id 与目录唯一对应
    const finalId = renamed ? shortId() : id
    if (renamed) meta.id = finalId
    // 解压所有条目到项目目录（跳过目录条目）
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue
      const target = path.join(projectDir, entry.entryName)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, entry.getData())
    }
    // 确保 project.json 存在且 id/name 正确（包内缺失或撞名时补写/重写；v1 包迁移补 v2 字段）
    const metaPath = path.join(projectDir, PROJECT_META_FILE)
    try {
      const onDisk = JSON.parse(await fs.readFile(metaPath, 'utf8'))
      const migrated = ensureV2Fields(onDisk)
      migrated.id = finalId
      migrated.name = name
      migrated.formatVersion = FORMAT_VERSION
      // v1 包无命名空间目录时，补建 assets/<ns>/ 骨架
      const nsDir = path.join(projectDir, ASSETS_DIR, migrated.defaultNamespace)
      await fs.mkdir(nsDir, { recursive: true })
      await fs.writeFile(metaPath, JSON.stringify(migrated, null, 2), 'utf8')
    } catch {
      const migrated = ensureV2Fields({ ...meta, id: finalId })
      migrated.updatedAt = new Date().toISOString()
      await fs.writeFile(metaPath, JSON.stringify(migrated, null, 2), 'utf8')
    }
    const { projects } = await list()
    const imported = projects.find((p) => p.id === finalId) ?? null
    return { project: imported }
  }

  /** 导出项目：打包目录 → 返回 zip buffer（保存落点由调用方弹框） */
  async function exportPackage(id) {
    const found = await findDirById(id)
    if (!found) {
      throw new Error(`项目不存在: ${id}`)
    }
    const { projectDir } = found
    // 打包前刷新 updatedAt
    const meta = await readMeta(projectDir)
    if (meta) {
      meta.updatedAt = new Date().toISOString()
      await fs.writeFile(path.join(projectDir, PROJECT_META_FILE), JSON.stringify(meta, null, 2), 'utf8')
    }
    const zip = zipProject(projectDir)
    return {
      fileName: `${meta?.name ?? displayNameFromDir(path.basename(projectDir))}${PROJECT_PACKAGE_EXT}`,
      buffer: zip.toBuffer(),
    }
  }

  /** 删除项目目录（二次确认由 UI 层负责） */
  async function remove(id) {
    const found = await findDirById(id)
    if (!found) {
      throw new Error(`项目不存在: ${id}`)
    }
    await fs.rm(found.projectDir, { recursive: true, force: true })
    return { ok: true }
  }

  /** 关闭项目：更新 updatedAt（前端主导清状态） */
  async function close(id) {
    const found = await findDirById(id)
    if (found?.meta) {
      found.meta.updatedAt = new Date().toISOString()
      await fs.writeFile(
        path.join(found.projectDir, PROJECT_META_FILE),
        JSON.stringify(found.meta, null, 2),
        'utf8',
      )
    }
    return { ok: true }
  }

  /**
   * 更新 project.json 配置（project 资源编辑器的数据链路终点）。
   * patch：嵌套对象深合并到磁盘 meta（数组/标量替换），写回前刷新 updatedAt，
   * 返回合并后的最新 meta（前端缓存用它回写，保证磁盘权威 + 单向确认）。
   */
  async function updateMeta(id, patch) {
    const found = await findDirById(id)
    if (!found) {
      throw new Error(`项目不存在: ${id}`)
    }
    const { projectDir, meta } = found
    const merged = deepMergeMeta(meta, patch ?? {})
    merged.updatedAt = new Date().toISOString()
    await fs.writeFile(
      path.join(projectDir, PROJECT_META_FILE),
      JSON.stringify(merged, null, 2),
      'utf8',
    )
    return { project: toProject(merged, projectDir) }
  }

  /** 读取最新 project.json 配置（返回前端 ProjectMeta 形态；编辑器初始化 / 外部改动同步用） */
  async function readMetaConfig(id) {
    const found = await findDirById(id)
    if (!found) {
      throw new Error(`项目不存在: ${id}`)
    }
    return { project: toProject(found.meta, found.projectDir) }
  }

  return {
    homeDir,
    list,
    create,
    open,
    close,
    import: importPackage,
    export: exportPackage,
    remove,
    updateMeta,
    readMetaConfig,
    // 通用资源文件 CRUD
    readFile,
    writeFile,
    createFile,
    deleteFile,
    // 通用目录 CRUD（层级校验在函数内）
    createDir,
    deleteDir,
    // 重命名/移动
    rename,
  }
}

/** 深合并：plain object 递归合并，数组/标量直接替换（与前端 SchemaRegistry.patch 语义一致） */
function deepMergeMeta(base, patch) {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = deepMergeMeta(out[k], v)
  }
  return out
}
