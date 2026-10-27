/**
 * project 模块 —— 受管理的项目工作区（~/.liteweave/projects/）。
 *
 * 职责（用户定案）：
 * - 项目不再指向任意磁盘目录，全部收拢到 LiteWeave 家目录的 projects/ 下
 * - 启动器（ProjectLauncher）展示项目列表；打开项目后进入编辑器
 * - 导入/导出用 .liteweave（zip）包；彻底移除“打开任意磁盘目录”能力
 * - 所有项目操作都走统一指令通道（命令），人工与 AI 同一条链路
 *
 * 通讯：统一走 ctx.transport.invoke（Electron=IPC / Web=HTTP，协议一致 endpoint+JSON）。
 * Web 降级：非 Electron 环境没有项目管理能力，操作会返回 { canceled: true, error: 'not-in-electron' }。
 *
 * 资源树节点结构与主进程 readDirTree 一致：{ name, path, type: 'directory'|'file', children? }
 */
import type { Module, ModuleContext } from '../module.js'
import { commandEventName } from '../commandBus.js'
import { systemCommand } from '../namespace.js'
import type { IEventBus } from '../types.js'
import type { Transport } from '../transport/index.js'

/* ---------------- 类型 ---------------- */

/** 项目类型（全局配置；3D 开放 model/mesh/material 等资源类型） */
export type ProjectType = '2d' | '3d'

/** 项目元数据（与主进程 ProjectMeta 一致；v2 含资源协议字段） */
export interface ProjectMeta {
  /** 短 ID（目录命名 <name>-<id>） */
  id: string
  /** 显示名 */
  name: string
  /** 项目目录名（name-id） */
  dirName: string
  /** 项目目录绝对路径 */
  path: string
  /** 创建时间 ISO */
  createdAt: string
  /** 最近更新时间 ISO */
  updatedAt: string
  /** 项目格式版本 */
  formatVersion: number
  /** 项目类型（全局配置） */
  type: ProjectType
  /** 默认命名空间（新资源默认归属） */
  defaultNamespace: string
  /** 全部命名空间（≥1，defaultNamespace 必在内） */
  namespaces: string[]
  /** 分域整体参数（rendering/input/physics/build…） */
  settings: Record<string, unknown>
  /** 引擎启动入口（资源 id，如 demo:scenes/main.scene） */
  entry: string
  /** 资源清单（平铺、权威、编辑器维护） */
  resources: Array<{ id: string; type: string; path: string }>
  /** 项目语言列表（.lang 资源按 id 命名 <id>.lang） */
  languages: Array<{ id: string; display_name: string }>
}

/** 资源树节点（与主进程 readDirTree 输出一致） */
export interface ProjectNode {
  name: string
  /** 虚拟路径：相对项目根，/ 分隔（不暴露绝对路径） */
  path: string
  type: 'directory' | 'file'
  children?: ProjectNode[]
}

/** 通用操作结果 */
export interface ProjectResult {
  canceled: boolean
  error?: string
  /** 打开/新建/导入成功时返回 */
  project?: ProjectMeta
  /** 打开成功时返回 */
  tree?: ProjectNode[]
}

/** 事件名：项目打开成功，携带 { project, tree }（system 命名空间前缀，全局隔离） */
export const PROJECT_OPENED = systemCommand('project:opened')
/** 事件名：项目打开被取消/失败，携带 { canceled, error? } */
export const PROJECT_OPEN_FAILED = systemCommand('project:open-failed')
/** 事件名：项目关闭，载荷空（启动器显示） */
export const PROJECT_CLOSED = systemCommand('project:closed')
/** 事件名：项目列表变更，携带 { projects }（增删/导入导出后刷新） */
export const PROJECT_LIST_CHANGED = systemCommand('project:list-changed')
/** 事件名：project.json 配置变更（编辑器/AI 写盘后回推），携带 { project }（最新全量 meta） */
export const PROJECT_CONFIG_CHANGED = systemCommand('project:config:changed')
/** 事件名：资源树变更（创建/删除/写资源文件后刷新），携带 { tree }（最新资源树） */
export const PROJECT_TREE_CHANGED = systemCommand('project:tree-changed')
/** 事件名：资源文件已删除（删除成功后广播），携带 { path }；供编辑器标签等按路径清理 */
export const RESOURCE_DELETED = systemCommand('resource:deleted')

/** 命令名：触发打开项目流程（文件菜单 / 启动器 / AI 指令调用） */
export const OPEN_PROJECT_COMMAND = systemCommand('project:open')
/** 命令名：新建项目（携带 { name }） */
export const CREATE_PROJECT_COMMAND = systemCommand('project:create')
/** 命令名：关闭当前项目 */
export const CLOSE_PROJECT_COMMAND = systemCommand('project:close')
/** 命令名：导入 .liteweave 项目包 */
export const IMPORT_PROJECT_COMMAND = systemCommand('project:import')
/** 命令名：导出项目（携带 { id }） */
export const EXPORT_PROJECT_COMMAND = systemCommand('project:export')
/** 命令名：删除项目（携带 { id }） */
export const REMOVE_PROJECT_COMMAND = systemCommand('project:remove')
/** 命令名：写 project.json 配置（携带 { patch }：嵌套对象深合并到磁盘 meta；人工/AI 同链路） */
export const SET_PROJECT_CONFIG_COMMAND = systemCommand('project:config:set')
/** 命令名：创建资源文件（携带 { path?, name?, namespace?, content? }；AI/MCP 生命周期入口） */
export const CREATE_RESOURCE_COMMAND = systemCommand('resource:create')
/** 命令名：删除资源文件（携带 { path }） */
export const DELETE_RESOURCE_COMMAND = systemCommand('resource:delete')
/** 命令名：写资源文件（携带 { path, content }） */
export const WRITE_RESOURCE_COMMAND = systemCommand('resource:write')
/** 命令名：创建目录（携带 { path }；自由创建，不限层级；AI/MCP 生命周期入口） */
export const CREATE_DIR_COMMAND = systemCommand('dir:create')
/** 命令名：删除目录（携带 { path }；递归删除） */
export const DELETE_DIR_COMMAND = systemCommand('dir:delete')
/** 命令名：重命名/移动文件或目录（携带 { oldPath, newPath }；fs.rename；同步 project.json 资源清单） */
export const RENAME_COMMAND = systemCommand('resource:rename')
/** 命令名：打开项目配置编辑器（菜单"文件→项目配置"触发；等价于 system.resource:open { path:'project.json' }） */
export const OPEN_PROJECT_CONFIG_COMMAND = systemCommand('project:config:open')
/** 命令名：打开资源（资源管理器点击文件 / 项目配置菜单转发）：{ path, name } → AppShell 匹配资源类型 → 打开编辑器标签 */
export const OPEN_RESOURCE_COMMAND = systemCommand('resource:open')
/** 事件名：资源已重命名（重命名成功后广播，携带 { oldPath, newPath, isDir }）；编辑器标签/历史栈按路径迁移 */
export const RESOURCE_RENAMED = systemCommand('resource:renamed')

/** 打开/新建项目参数 */
export interface ProjectArgs {
  /** 项目 id（打开/导出/删除用） */
  id?: string
  /** 项目名（新建用） */
  name?: string
  /** 项目类型 2d/3d（新建用，默认 2d） */
  type?: ProjectType
  /** 默认命名空间（新建用，默认=项目名小写） */
  defaultNamespace?: string
}

/** 新建项目参数 */
export interface CreateProjectArgs {
  /** 项目名 */
  name: string
  /** 项目类型 2d/3d（默认 2d） */
  type?: ProjectType
  /** 默认命名空间（默认=项目名小写，可改） */
  defaultNamespace?: string
}

export interface ProjectApi {
  /** 拉取项目列表 */
  list(): Promise<ProjectMeta[]>
  /** 新建项目并打开（name 必填；type/defaultNamespace 可选） */
  create(args: CreateProjectArgs): Promise<ProjectResult>
  /** 打开项目（按 id） */
  open(id: string): Promise<ProjectResult>
  /** 关闭当前项目 */
  close(): Promise<void>
  /** 导入 .liteweave 项目包（弹系统文件框，主进程侧） */
  import(): Promise<ProjectResult>
  /** 导出项目为 .liteweave 包 */
  export(id: string): Promise<ProjectResult>
  /** 删除项目 */
  remove(id: string): Promise<ProjectResult>
  /** 当前项目元数据（未打开为 undefined） */
  getCurrentProject(): ProjectMeta | undefined
  /** 当前项目资源树（未打开为 undefined） */
  getTree(): ProjectNode[] | undefined
  /** 刷新当前项目资源树（文件增删写后调用）；无项目忽略，返回最新树 */
  refreshTree(): Promise<ProjectNode[] | undefined>
  /** 读取当前项目 project.json 配置（cache 权威；未拉取过则返回 undefined，消费方调 loadConfig） */
  getConfig(): ProjectMeta | undefined
  /** 从磁盘拉取当前项目 project.json 全量到 cache 并广播 system.project:config:loaded */
  loadConfig(): Promise<ProjectMeta | undefined>
  /** 写 project.json：patch 深合并到磁盘（主进程写盘），返回最新 meta 并广播 config:changed；未打开项目时抛错 */
  saveConfig(patch: Record<string, unknown>): Promise<ProjectMeta>
  /** 读取资源文件文本（UTF-8）；返回 { content }；未打开项目/文件不存在抛错 */
  readFile(path: string): Promise<{ content: string }>
  /** 写资源文件（创建或覆盖；父目录自动创建）；写盘后刷新资源树并广播 tree:changed */
  writeFile(path: string, content: string): Promise<void>
  /** 创建资源文件 + 同步资源清单（type 按后缀推断）；已存在返回 { ok:false,error }；成功后刷新资源树 */
  createFile(args: { path?: string; name?: string; namespace?: string; content?: string }): Promise<{ ok: boolean; error?: string }>
  /** 删除资源文件 + 从资源清单移除；文件不存在返回 { ok:false,error }；成功后刷新资源树 */
  deleteFile(path: string): Promise<{ ok: boolean; error?: string }>
  /** 创建目录（自由创建，不限层级）；已存在返回 { ok:false,error }；成功后刷新资源树 */
  createDir(args: { path: string }): Promise<{ ok: boolean; error?: string }>
  /** 删除目录（递归）；不存在返回 { ok:false,error }；成功后刷新资源树并广播 RESOURCE_DELETED（按目录下文件路径） */
  deleteDir(path: string): Promise<{ ok: boolean; error?: string }>
  /** 重命名/移动文件或目录（fs.rename）；同步 project.json 资源清单；成功后刷新资源树并广播 RESOURCE_RENAMED */
  rename(oldPath: string, newPath: string): Promise<{ ok: boolean; error?: string }>
  /** 订阅项目事件；返回取消订阅函数 */
  subscribe(listener: (event: string, payload: unknown) => void): () => void
}

/** 扩展模块上下文：挂 project api */
export interface ProjectModuleContext extends ModuleContext {
  project?: ProjectApi
}

/* ---------------- 模块 ---------------- */

/** project:* invoke 的返回契约（与主进程 handler 一致） */
interface ProjectInvokeResult extends ProjectResult {
  projects?: ProjectMeta[]
  ok?: boolean
}

/** 把 invoke 结果里的 { error } 转成异常（与 transport.request 语义一致） */
function throwIfError(result: ProjectInvokeResult | undefined): void {
  if (result && typeof result.error === 'string') {
    throw new Error(result.error)
  }
}

/** 在资源树中按路径查找节点（递归） */
function findNodeInTree(nodes: ProjectNode[] | undefined, targetPath: string): ProjectNode | undefined {
  if (!nodes) return undefined
  for (const n of nodes) {
    if (n.path === targetPath) return n
    if (n.type === 'directory' && n.children) {
      const found = findNodeInTree(n.children, targetPath)
      if (found) return found
    }
  }
  return undefined
}

export function createProjectModule(): ProjectModule {
  // 前端项目状态：列表 + 当前项目 + 资源树（权威读取源，组件拉取渲染）
  let projectList: ProjectMeta[] = []
  let currentProject: ProjectMeta | undefined
  let tree: ProjectNode[] | undefined
  /** 当前项目 project.json 配置 cache（权威读取源；编辑器/自动化统一用） */
  let config: ProjectMeta | undefined
  let events: IEventBus | undefined
  let transport: Transport | undefined

  const listeners = new Set<(event: string, payload: unknown) => void>()

  function broadcast(event: string, payload: unknown): void {
    void events?.emit(event, payload)
    for (const listener of listeners) {
      try {
        listener(event, payload)
      } catch (err) {
        console.error('[project] 监听器异常:', err)
      }
    }
  }

  /** 应用打开结果：更新当前项目状态 + 广播事件；返回是否成功打开 */
  function applyOpened(result: ProjectResult): boolean {
    if (result.canceled || !result.project || !result.tree) {
      broadcast(PROJECT_OPEN_FAILED, result)
      return false
    }
    currentProject = result.project
    tree = result.tree
    // 新项目：配置 cache 未加载，置空（打开项目后由编辑器/自动化按需 loadConfig）
    config = undefined
    broadcast(PROJECT_OPENED, { project: result.project, tree: result.tree })
    return true
  }

  /** 非 Electron 环境的降级结果 */
  function notInElectron(): ProjectResult {
    const result: ProjectResult = { canceled: true, error: 'not-in-electron' }
    broadcast(PROJECT_OPEN_FAILED, result)
    return result
  }

  /** 刷新项目列表并广播变更 */
  async function refreshList(): Promise<ProjectMeta[]> {
    const r = await transport?.invoke<ProjectInvokeResult>('project:list')
    throwIfError(r)
    projectList = r?.projects ?? []
    broadcast(PROJECT_LIST_CHANGED, { projects: projectList })
    return projectList
  }

  /** 刷新当前项目资源树并广播变更（文件增删写后调用；无项目忽略） */
  async function refreshTreeInternal(): Promise<ProjectNode[] | undefined> {
    const id = currentProject?.id
    if (!id || !transport || transport.adapter.kind !== 'electron') return tree
    try {
      const r = await transport.invoke<ProjectInvokeResult>('project:open', { id })
      throwIfError(r)
      if (r.tree) {
        tree = r.tree
        broadcast(PROJECT_TREE_CHANGED, { tree })
      }
      return tree
    } catch (err) {
      console.error('[project] 刷新资源树失败:', err)
      return tree
    }
  }

  const api: ProjectApi = {
    async list(): Promise<ProjectMeta[]> {
      if (!transport || transport.adapter.kind !== 'electron') {
        return []
      }
      try {
        return await refreshList()
      } catch (err) {
        console.error('[project] 拉取项目列表失败:', err)
        return []
      }
    },

    async create({ name, type, defaultNamespace }: CreateProjectArgs): Promise<ProjectResult> {
      if (!transport || transport.adapter.kind !== 'electron') return notInElectron()
      try {
        const r = await transport.invoke<ProjectInvokeResult>('project:create', { name, type, defaultNamespace })
        throwIfError(r)
        if (!r.project) return { canceled: true, error: '新建项目未返回元数据' }
        // 创建后完整打开（含资源树 + 广播 PROJECT_OPENED → App 切换启动器→编辑器）
        const opened = await api.open(r.project.id)
        if (opened.project) {
          void refreshList()
          return opened
        }
        return { canceled: false, project: r.project }
      } catch (err) {
        console.error('[project] 新建项目失败:', err)
        return { canceled: true, error: String(err) }
      }
    },

    async open(id: string): Promise<ProjectResult> {
      if (!transport || transport.adapter.kind !== 'electron') return notInElectron()
      try {
        const r = await transport.invoke<ProjectInvokeResult>('project:open', { id })
        throwIfError(r)
        const result: ProjectResult = { canceled: r.canceled, project: r.project, tree: r.tree, error: r.error }
        applyOpened(result)
        return result
      } catch (err) {
        console.error('[project] 打开项目失败:', err)
        const result: ProjectResult = { canceled: true, error: String(err) }
        broadcast(PROJECT_OPEN_FAILED, result)
        return result
      }
    },

    async close(): Promise<void> {
      if (!transport || transport.adapter.kind !== 'electron') return
      const id = currentProject?.id
      try {
        if (id) {
          const r = await transport.invoke<ProjectInvokeResult>('project:close', { id })
          throwIfError(r)
        }
      } catch (err) {
        console.error('[project] 关闭项目失败:', err)
      }
      currentProject = undefined
      tree = undefined
      config = undefined
      broadcast(PROJECT_CLOSED, undefined)
    },

    async import(): Promise<ProjectResult> {
      if (!transport || transport.adapter.kind !== 'electron') return notInElectron()
      try {
        const r = await transport.invoke<ProjectInvokeResult>('project:import')
        throwIfError(r)
        if (r.canceled) return { canceled: true }
        void refreshList()
        return { canceled: false, project: r.project }
      } catch (err) {
        console.error('[project] 导入项目失败:', err)
        return { canceled: true, error: String(err) }
      }
    },

    async export(id: string): Promise<ProjectResult> {
      if (!transport || transport.adapter.kind !== 'electron') return notInElectron()
      try {
        const r = await transport.invoke<ProjectInvokeResult>('project:export', { id })
        throwIfError(r)
        return { canceled: r.canceled ?? false, error: r.error }
      } catch (err) {
        console.error('[project] 导出项目失败:', err)
        return { canceled: true, error: String(err) }
      }
    },

    async remove(id: string): Promise<ProjectResult> {
      if (!transport || transport.adapter.kind !== 'electron') return notInElectron()
      try {
        const r = await transport.invoke<ProjectInvokeResult>('project:remove', { id })
        throwIfError(r)
        if (currentProject?.id === id) {
          currentProject = undefined
          tree = undefined
          broadcast(PROJECT_CLOSED, undefined)
        }
        void refreshList()
        return { canceled: false }
      } catch (err) {
        console.error('[project] 删除项目失败:', err)
        return { canceled: true, error: String(err) }
      }
    },

    getCurrentProject(): ProjectMeta | undefined {
      return currentProject
    },

    getTree(): ProjectNode[] | undefined {
      return tree
    },

    async refreshTree(): Promise<ProjectNode[] | undefined> {
      return refreshTreeInternal()
    },

    getConfig(): ProjectMeta | undefined {
      return config
    },

    async loadConfig(): Promise<ProjectMeta | undefined> {
      const id = currentProject?.id
      if (!id || !transport || transport.adapter.kind !== 'electron') {
        return config
      }
      try {
        const r = await transport.invoke<ProjectInvokeResult>('project:config:read', { id })
        throwIfError(r)
        config = r.project
        broadcast(PROJECT_CONFIG_CHANGED, { project: config })
        return config
      } catch (err) {
        console.error('[project] 读取 project.json 配置失败:', err)
        return config
      }
    },

    async saveConfig(patch: Record<string, unknown>): Promise<ProjectMeta> {
      const id = currentProject?.id
      if (!id) {
        throw new Error('[project] 未打开项目，无法写 project.json 配置')
      }
      if (!transport || transport.adapter.kind !== 'electron') {
        throw new Error('not-in-electron')
      }
      const r = await transport.invoke<ProjectInvokeResult>('project:config:write', { id, patch })
      throwIfError(r)
      if (!r.project) {
        throw new Error('[project] 写 project.json 配置未返回最新元数据')
      }
      config = r.project
      // 同步当前项目元数据（name/updatedAt 等配置字段变化会反映到启动器列表）
      currentProject = { ...currentProject, ...r.project }
      broadcast(PROJECT_CONFIG_CHANGED, { project: r.project })
      return r.project
    },

    async readFile(path: string): Promise<{ content: string }> {
      const id = currentProject?.id
      if (!id || !transport || transport.adapter.kind !== 'electron') {
        throw new Error('not-in-electron')
      }
      const r = await transport.invoke<ProjectInvokeResult>('project:file:read', { id, path })
      throwIfError(r)
      return { content: (r as { content?: string }).content ?? '' }
    },

    async writeFile(path: string, content: string): Promise<void> {
      const id = currentProject?.id
      if (!id || !transport || transport.adapter.kind !== 'electron') {
        throw new Error('not-in-electron')
      }
      const r = await transport.invoke<ProjectInvokeResult>('project:file:write', { id, path, content })
      throwIfError(r)
      // 写盘后刷新资源树（新建文件/父目录可能新增），广播给资源管理器
      await api.refreshTree()
    },

    async createFile(args: { path?: string; name?: string; namespace?: string; content?: string }): Promise<{ ok: boolean; error?: string }> {
      const id = currentProject?.id
      if (!id || !transport || transport.adapter.kind !== 'electron') {
        return { ok: false, error: 'not-in-electron' }
      }
      const r = await transport.invoke<ProjectInvokeResult>('project:file:create', { id, ...args })
      throwIfError(r)
      if (r.ok) {
        await api.refreshTree()
        // 资源清单（resources）随创建同步变化：重拉 config 到 cache，保证编辑器/联动读到最新
        await api.loadConfig()
      }
      return { ok: !!r.ok, error: (r as { error?: string }).error }
    },

    async deleteFile(path: string): Promise<{ ok: boolean; error?: string }> {
      const id = currentProject?.id
      if (!id || !transport || transport.adapter.kind !== 'electron') {
        return { ok: false, error: 'not-in-electron' }
      }
      const r = await transport.invoke<ProjectInvokeResult>('project:file:delete', { id, path })
      throwIfError(r)
      if (r.ok) {
        await api.refreshTree()
        // 资源清单（resources）随删除同步变化：重拉 config 到 cache
        await api.loadConfig()
        // 广播资源已删除（编辑器标签等按路径清理；删除语言联动场景同样触发）
        broadcast(RESOURCE_DELETED, { path })
      }
      return { ok: !!r.ok, error: (r as { error?: string }).error }
    },

    async createDir(args: { path: string }): Promise<{ ok: boolean; error?: string }> {
      const id = currentProject?.id
      if (!id || !transport || transport.adapter.kind !== 'electron') {
        return { ok: false, error: 'not-in-electron' }
      }
      const r = await transport.invoke<ProjectInvokeResult>('project:dir:create', { id, ...args })
      throwIfError(r)
      if (r.ok) {
        await api.refreshTree()
      }
      return { ok: !!r.ok, error: (r as { error?: string }).error }
    },

    async deleteDir(path: string): Promise<{ ok: boolean; error?: string }> {
      const id = currentProject?.id
      if (!id || !transport || transport.adapter.kind !== 'electron') {
        return { ok: false, error: 'not-in-electron' }
      }
      // 删除前：收集目录下所有文件路径，用于删除后广播 RESOURCE_DELETED（编辑器标签按路径清理）
      const filesInDir: string[] = []
      const collectFiles = (nodes: ProjectNode[] | undefined, prefix: string): void => {
        if (!nodes) return
        for (const n of nodes) {
          const p = prefix ? `${prefix}/${n.name}` : n.path
          if (n.type === 'file') filesInDir.push(n.path)
          else if (n.type === 'directory' && n.children) collectFiles(n.children, p)
        }
      }
      if (tree) {
        const target = findNodeInTree(tree, path)
        if (target?.type === 'directory') collectFiles(target.children, path)
      }
      const r = await transport.invoke<ProjectInvokeResult>('project:dir:delete', { id, path })
      throwIfError(r)
      if (r.ok) {
        await api.refreshTree()
        await api.loadConfig()
        // 广播每个被删文件（编辑器标签按路径清理）
        for (const fp of filesInDir) broadcast(RESOURCE_DELETED, { path: fp })
      }
      return { ok: !!r.ok, error: (r as { error?: string }).error }
    },

    async rename(oldPath: string, newPath: string): Promise<{ ok: boolean; error?: string }> {
      const id = currentProject?.id
      if (!id || !transport || transport.adapter.kind !== 'electron') {
        return { ok: false, error: 'not-in-electron' }
      }
      // 判断源是目录还是文件（用于广播 isDir；目录重命名后所有前缀匹配的资源路径都要迁移）
      const srcNode = tree ? findNodeInTree(tree, oldPath) : undefined
      const isDir = srcNode?.type === 'directory'
      const r = await transport.invoke<ProjectInvokeResult>('project:rename', { id, oldPath, newPath })
      throwIfError(r)
      if (r.ok) {
        await api.refreshTree()
        await api.loadConfig()
        // 广播重命名事件（编辑器标签按 oldPath→newPath 迁移；history.renamePath 联动）
        broadcast(RESOURCE_RENAMED, { oldPath, newPath, isDir })
      }
      return { ok: !!r.ok, error: (r as { error?: string }).error }
    },

    subscribe(listener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }

  const module: ProjectModule = {
    id: 'project',
    api,

    async init(ctx): Promise<void> {
      events = ctx.events
      transport = ctx.transport

      // 事件契约
      events.define({ name: PROJECT_OPENED, description: '项目打开成功，携带 { project, tree }' })
      events.define({ name: PROJECT_OPEN_FAILED, description: '项目打开被取消/失败，携带 { canceled, error? }' })
      events.define({ name: PROJECT_CLOSED, description: '项目关闭，载荷空' })
      events.define({ name: PROJECT_LIST_CHANGED, description: '项目列表变更，携带 { projects }' })
      events.define({ name: PROJECT_CONFIG_CHANGED, description: 'project.json 配置变更，携带 { project }' })
      events.define({ name: PROJECT_TREE_CHANGED, description: '资源树变更（创建/删除/写资源文件后刷新），携带 { tree }' })
      events.define({ name: RESOURCE_DELETED, description: '资源文件已删除（删除成功后广播），携带 { path }；供编辑器标签等按路径清理' })
      events.define({ name: RESOURCE_RENAMED, description: '资源已重命名/移动（重命名成功后广播），携带 { oldPath, newPath, isDir }；编辑器标签/历史栈按路径迁移' })
      events.define({ name: commandEventName(OPEN_PROJECT_COMMAND), description: '触发打开项目流程' })
      events.define({ name: commandEventName(CREATE_PROJECT_COMMAND), description: '新建项目（携带 { name }）' })
      events.define({ name: commandEventName(CLOSE_PROJECT_COMMAND), description: '关闭当前项目' })
      events.define({ name: commandEventName(IMPORT_PROJECT_COMMAND), description: '导入 .liteweave 项目包' })
      events.define({ name: commandEventName(EXPORT_PROJECT_COMMAND), description: '导出项目（携带 { id }）' })
      events.define({ name: commandEventName(REMOVE_PROJECT_COMMAND), description: '删除项目（携带 { id }）' })
      events.define({ name: commandEventName(SET_PROJECT_CONFIG_COMMAND), description: '写 project.json 配置（携带 { patch }）' })
      events.define({ name: commandEventName(CREATE_RESOURCE_COMMAND), description: '创建资源文件（携带 { path?, name?, namespace?, content? }）' })
      events.define({ name: commandEventName(DELETE_RESOURCE_COMMAND), description: '删除资源文件（携带 { path }）' })
      events.define({ name: commandEventName(WRITE_RESOURCE_COMMAND), description: '写资源文件（携带 { path, content }）' })
      events.define({ name: commandEventName(CREATE_DIR_COMMAND), description: '创建目录（携带 { path, namespace? }；层级校验在主进程）' })
      events.define({ name: commandEventName(DELETE_DIR_COMMAND), description: '删除目录（携带 { path }；递归删除）' })
      events.define({ name: commandEventName(RENAME_COMMAND), description: '重命名/移动文件或目录（携带 { oldPath, newPath }；fs.rename；同步 project.json 资源清单）' })
      events.define({ name: commandEventName(OPEN_PROJECT_CONFIG_COMMAND), description: '打开项目配置编辑器（菜单"文件→项目配置"触发；无载荷，等价于 system.resource:open { path:"project.json", name:"project.json" }）' })
      events.define({ name: commandEventName(OPEN_RESOURCE_COMMAND), description: '打开资源（携带 { path, name }；资源管理器点击文件 / 项目配置菜单转发）：AppShell 匹配资源类型 → 打开编辑器标签' })

      // 命令：人工操作与 AI 指令统一走这里
      ctx.commands.onCommand(OPEN_PROJECT_COMMAND, (args) => {
        const { id } = (args ?? {}) as ProjectArgs
        if (id) {
          // 带 id：直接打开（AI/命令驱动，绕开启动器）
          void api.open(id)
        } else if (currentProject) {
          // 不带 id：回到启动器（关闭当前项目，App 据此切换界面）
          void api.close()
        }
      })
      ctx.commands.onCommand(CREATE_PROJECT_COMMAND, (args) => {
        const { name, type, defaultNamespace } = (args ?? {}) as ProjectArgs
        if (name) void api.create({ name, type, defaultNamespace })
      })
      ctx.commands.onCommand(CLOSE_PROJECT_COMMAND, () => {
        void api.close()
      })
      ctx.commands.onCommand(IMPORT_PROJECT_COMMAND, () => {
        void api.import()
      })
      ctx.commands.onCommand(EXPORT_PROJECT_COMMAND, (args) => {
        const { id } = (args ?? {}) as ProjectArgs
        // id 缺省时导出当前项目（与 MCP 语义一致：'id 缺省当前项目'）
        void api.export(id ?? currentProject?.id ?? '')
      })
      ctx.commands.onCommand(REMOVE_PROJECT_COMMAND, (args) => {
        const { id } = (args ?? {}) as ProjectArgs
        if (id) void api.remove(id)
      })
      ctx.commands.onCommand(SET_PROJECT_CONFIG_COMMAND, (args) => {
        const { patch } = (args ?? {}) as { patch?: Record<string, unknown> }
        if (patch && typeof patch === 'object') {
          void api.saveConfig(patch).catch((err) => {
            console.error('[project] 写 project.json 配置失败:', err)
          })
        } else {
          console.warn(`[project] ${SET_PROJECT_CONFIG_COMMAND} 缺少 patch 对象`)
        }
      })
      ctx.commands.onCommand(CREATE_RESOURCE_COMMAND, (args) => {
        const { path, name, namespace, content } = (args ?? {}) as { path?: string; name?: string; namespace?: string; content?: string }
        if (path || name) {
          void api.createFile({ path, name, namespace, content }).catch((err) => {
            console.error('[project] 创建资源失败:', err)
          })
        } else {
          console.warn(`[project] ${CREATE_RESOURCE_COMMAND} 缺少 path 或 name`)
        }
      })
      ctx.commands.onCommand(DELETE_RESOURCE_COMMAND, async (args) => {
        const { path } = (args ?? {}) as { path?: string }
        if (path) {
          // await：让 MCP 调用方拿到删除结果（成功/失败），且 RESOURCE_DELETED 先于调用方后续动作
          await api.deleteFile(path).catch((err) => {
            console.error('[project] 删除资源失败:', err)
          })
        } else {
          console.warn(`[project] ${DELETE_RESOURCE_COMMAND} 缺少 path`)
        }
      })
      ctx.commands.onCommand(WRITE_RESOURCE_COMMAND, (args) => {
        const { path, content } = (args ?? {}) as { path?: string; content?: string }
        if (path) {
          void api.writeFile(path, content ?? '').catch((err) => {
            console.error('[project] 写资源失败:', err)
          })
        } else {
          console.warn(`[project] ${WRITE_RESOURCE_COMMAND} 缺少 path`)
        }
      })
      ctx.commands.onCommand(CREATE_DIR_COMMAND, (args) => {
        const { path } = (args ?? {}) as { path?: string }
        if (path) {
          void api.createDir({ path }).catch((err) => {
            console.error('[project] 创建目录失败:', err)
          })
        } else {
          console.warn(`[project] ${CREATE_DIR_COMMAND} 缺少 path`)
        }
      })
      ctx.commands.onCommand(DELETE_DIR_COMMAND, async (args) => {
        const { path } = (args ?? {}) as { path?: string }
        if (path) {
          await api.deleteDir(path).catch((err) => {
            console.error('[project] 删除目录失败:', err)
          })
        } else {
          console.warn(`[project] ${DELETE_DIR_COMMAND} 缺少 path`)
        }
      })
      ctx.commands.onCommand(RENAME_COMMAND, async (args) => {
        const { oldPath, newPath } = (args ?? {}) as { oldPath?: string; newPath?: string }
        if (oldPath && newPath) {
          await api.rename(oldPath, newPath).catch((err) => {
            console.error('[project] 重命名失败:', err)
          })
        } else {
          console.warn(`[project] ${RENAME_COMMAND} 缺少 oldPath 或 newPath`)
        }
      })
      // 打开项目配置编辑器：转发为 system.resource:open，由 AppShell 匹配 PROJECT_CONFIG_RESOURCE_TYPE 打开 ProjectConfigEditor 标签。
      // 不直接复用 system.resource:open 字符串，专用命令语义更清晰、菜单/MCP 可独立调用、未来可加权限/校验。
      ctx.commands.onCommand(OPEN_PROJECT_CONFIG_COMMAND, () => {
        const PROJECT_META_FILE = 'project.json'
        void ctx.commands.runCommand(OPEN_RESOURCE_COMMAND, { path: PROJECT_META_FILE, name: PROJECT_META_FILE }).catch((err) => {
          console.error('[project] 打开项目配置失败:', err)
        })
      })

      // 把 api 挂到上下文，供其它模块/组件取用
      const projectCtx = ctx as ProjectModuleContext
      projectCtx.project = api
      // 同时挂到服务容器（services.<id>，统一服务发现；core.services 供组件取用）
      projectCtx.services['project'] = api
    },
  }

  return module
}

/** project 模块实例类型：Module + 公开 api */
export interface ProjectModule extends Module {
  api: ProjectApi
}
