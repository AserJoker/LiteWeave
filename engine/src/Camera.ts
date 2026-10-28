/**
 * Camera 类 —— 引擎层相机对象（封装状态 + 算 view/projection 矩阵）。
 *
 * 定位（见任务 #50）：
 * - Camera 是"脚本层业务概念"，但当前阶段脚本层未落地，暂时放引擎层（Native）实现
 * - 未来脚本层落地后，Camera 类会搬到脚本层（脚本持 Camera 实例操作）
 * - Renderer 不持 Camera 对象 —— 跨层只传扁平矩阵（view/projection Float32Array，见隔离层契约）
 *
 * 职责：
 * - 封装相机状态（type/position/target/up/fov/near/far/aspect）
 * - 提供 computeView/computeProjection 算矩阵方法
 * - 调用方（Runner/脚本）持 Camera 实例，算出矩阵后调 renderer.setView/setProjection 同步
 *
 * 与 Scene.camera 的关系：
 * - Scene.camera 是资产描述（编辑期定义的初始相机信息，不可变）
 * - Camera 实例从 scene.camera 初始化（Camera.fromSceneCamera(scene.camera)）
 * - 运行时修改 Camera 实例的字段（position/target/fov 等）不影响 scene.camera
 */
import { mat4 } from 'gl-matrix'
import type { Camera as CameraDesc } from './types.js'

export class Camera {
  /** 投影类型：'perspective'（透视）| 'orthographic'（正交，占位未实现） */
  type: 'perspective' | 'orthographic'
  /** 相机位置（世界坐标） */
  position: [number, number, number]
  /** 观察目标点（世界坐标） */
  target: [number, number, number]
  /** 上方向（世界坐标；通常 [0,1,0]） */
  up: [number, number, number]
  /** 垂直视场角（弧度）；type='perspective' 时使用 */
  fov: number
  /** 近裁剪面距离 */
  near: number
  /** 远裁剪面距离 */
  far: number
  /** 宽高比；缺省时由调用方（Runner）用 canvas 物理宽高比填充 */
  aspect?: number
  /**
   * 同步矩阵给 Renderer（脚本改完字段后调此方法）。
   * Camera 类本身不持 Renderer 引用（保持纯业务对象）；
   * apply 由 Runner 创建 Camera 实例时动态注入闭包：
   *   camera.apply = () => { renderer.setView(camera.computeView()); renderer.setProjection(camera.computeProjection()) }
   * 脚本调 camera.apply() 时触发已注入的闭包。
   * 缺省无操作（未注入时静默跳过，便于纯计算场景使用 Camera）。
   */
  apply?: () => void

  constructor(opts: {
    type: 'perspective' | 'orthographic'
    position: [number, number, number]
    target: [number, number, number]
    up: [number, number, number]
    fov: number
    near: number
    far: number
    aspect?: number
  }) {
    this.type = opts.type
    this.position = [opts.position[0], opts.position[1], opts.position[2]]
    this.target = [opts.target[0], opts.target[1], opts.target[2]]
    this.up = [opts.up[0], opts.up[1], opts.up[2]]
    this.fov = opts.fov
    this.near = opts.near
    this.far = opts.far
    this.aspect = opts.aspect
  }

  /** 从 Scene.camera 资产描述初始化 Camera 实例（数组字段显式拷贝，避免共享引用） */
  static fromSceneCamera(desc: CameraDesc): Camera {
    return new Camera({
      type: desc.type,
      position: [desc.position[0], desc.position[1], desc.position[2]],
      target: [desc.target[0], desc.target[1], desc.target[2]],
      up: [desc.up[0], desc.up[1], desc.up[2]],
      fov: desc.fov,
      near: desc.near,
      far: desc.far,
      aspect: desc.aspect,
    })
  }

  /** 算 view 矩阵（view = lookAt(position, target, up)） */
  computeView(): Float32Array {
    const view = mat4.create()
    mat4.lookAt(view, this.position, this.target, this.up)
    return view as Float32Array
  }

  /** 算 projection 矩阵（按 type 分流；type='orthographic' 当前未实现抛错） */
  computeProjection(): Float32Array {
    if (this.type === 'orthographic') {
      throw new Error('[camera] orthographic projection 暂未实现（需补 left/right/top/bottom 或 size 字段）')
    }
    if (this.aspect === undefined) {
      throw new Error('[camera] aspect 未设置（perspective 投影需要 aspect；调用方应先设置 camera.aspect = canvas.width/height）')
    }
    const projection = mat4.create()
    mat4.perspective(projection, this.fov, this.aspect, this.near, this.far)
    return projection as Float32Array
  }

  /** 同步算出 view + projection 两个矩阵（便捷方法；等价于分别调 computeView/computeProjection） */
  computeViewProjection(): { view: Float32Array; projection: Float32Array } {
    return {
      view: this.computeView(),
      projection: this.computeProjection(),
    }
  }
}
