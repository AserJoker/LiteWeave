/**
 * Shader 资源 loader —— 加载 .wgsl 文件为纯字符串。
 *
 * shader 不直接进 Renderer，而是被 pipeline 引用（pipeline.loader 读 .wgsl 后塞进 Pipeline.shaderSource）。
 * 单独注册 shader type 是为了支持：
 * - project.json 清单可独立列出 shader 资源（IDE 资源树显示）
 * - pipeline loader 通过 ctx.loadAsset<string>(shaderId) 递归加载（带缓存，多 pipeline 共享同一 shader 源）
 */
import type { AssetTypeLoader } from '../types.js'

export const shaderLoader: AssetTypeLoader<string> = {
  type: 'shader',
  extensions: ['.wgsl', '.vert', '.frag', '.comp', '.glsl'] as const,
  async load(_id, parsedId, ctx) {
    const relativePath = `assets/${parsedId.namespace}/${parsedId.path}`
    const source = await ctx.fs.readText(relativePath)
    return source
  },
}
