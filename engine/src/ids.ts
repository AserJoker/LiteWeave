/**
 * 运行时对象内部 id 生成器。
 *
 * 用于 RenderObject / PipelineGraph 等运行时对象的内部 id。
 * - 引擎侧自增生成，代码不可硬编码
 * - 仅用于比较/打印/去重/Handle 标识/缓存 key
 * - 脚本侧拿不到具体值，只能持 Handle 接收
 *
 * 持久化资产的外部 id（`<namespace>:<path>`）不在此处生成，由资产加载器从磁盘加载时确定。
 */

let nextRuntimeId = 1

/** 生成下一个运行时对象内部 id（自增，从 1 开始；0 保留为 invalid） */
export function createRuntimeId(): number {
  const id = nextRuntimeId
  nextRuntimeId += 1
  return id
}

/** 重置 id 计数器（仅测试用；生产代码不应调用） */
export function _resetRuntimeIdForTest(): void {
  nextRuntimeId = 1
}
