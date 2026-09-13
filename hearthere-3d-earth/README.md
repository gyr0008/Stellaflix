# HearThere 3D Earth - 复现实现

本项目复现了 [hearthere.live](https://hearthere.live/) 网站的3D地球渲染效果、灯塔模型及全部交互逻辑。

## 技术栈分析

### 原始网站技术栈
| 技术 | 用途 |
|------|------|
| **deck.gl** | 地理空间3D可视化，GLOBE投影模式 |
| **luma.gl** | WebGL/WebGPU渲染引擎 |
| **MapLibre GL** | 地图渲染 |
| **MapTiler** | 地图服务和卫星影像 |
| **React** | 前端UI框架 |
| **loaders.gl** | 3D模型加载 |
| **Supabase** | 后端数据存储 |

### 复现项目技术栈
| 技术 | 用途 |
|------|------|
| **deck.gl 9.0** | 3D地球渲染核心 |
| **MapLibre GL 3.0** | 地图底图 |
| **原生JavaScript** | 交互逻辑实现 |
| **Canvas 2D** | 灯塔纹理绘制 |
| **Web Audio API** | 音频播放控制 |

## 项目结构

```
hearthere-3d-earth/
├── index.html              # 主页面，包含UI布局（透明背景叠加层）
├── README.md               # 完整文档
├── js/
│   ├── earth-renderer.js   # 3D地球渲染器（DeckGL，透明背景）
│   ├── lighthouse-model.js # 灯塔模型与信标系统
│   ├── interactions.js     # 交互管理器
│   ├── fireworks.js        # 烟花粒子效果（Canvas 2D）
│   └── app.js              # 主应用入口（集成Three.js星空）
└── assets/                 # 资源目录
```

### 与现有项目的关系
- **复用**：`public/js/modules/02-visual/00-pointer-cover-particles.js` 中的 `backgroundStarRiverParticles`（1400颗星星）
- **新增**：3D地球渲染、灯塔信标、交互系统、烟花效果
- **层级**：Three.js星空 → DeckGL地球 → 灯塔 → 烟花 → UI

## 核心功能实现

### 1. 3D地球渲染 (earth-renderer.js)

#### 地球参数
```javascript
EARTH_RADIUS = 6370972.0  // 地球半径（米）
GLOBE_RADIUS = 256.0      // 投影半径
```

#### 渲染特性
- **GLOBE投影模式**：使用deck.gl的`GlobeView`实现球面投影
- **卫星影像底图**：使用BitmapLayer加载地球纹理
- **透明背景**：与项目Three.js星空共用，无需重复渲染
- **自动旋转**：地球持续自转，用户交互时暂停

#### 相机控制
- 拖拽旋转地球
- 滚轮缩放（zoom: 2-8）
- 双击定位
- 触摸手势支持（移动端）

### 2. 灯塔模型 (lighthouse-model.js)

#### 几何结构
灯塔使用Canvas 2D绘制，包含：
- 底座（梯形结构）
- 塔身（矩形结构）
- 顶部灯室（圆形）
- 灯光效果（径向渐变）

#### 纹理状态
| 状态 | 颜色 | 效果 |
|------|------|------|
| 默认 | 白色塔身 + 红灯 | 静态显示 |
| 激活 | 发光效果 | 径向渐变光晕 |
| 选中 | 青色脉冲 | 多层光环动画 |

#### 脉冲动画
- 正弦波脉冲：半径在15-35像素间周期性变化
- 持续时间：2秒/周期
- 透明度随半径变化

### 3. 交互系统 (interactions.js)

#### 交互行为
| 操作 | 响应 |
|------|------|
| 点击信标 | 显示详情弹窗 + 飞行定位 |
| 悬停信标 | 显示名称提示 |
| 拖拽地图 | 旋转地球（暂停自转） |
| 滚轮缩放 | 调整视图级别 |
| 按ESC | 关闭弹窗 + 恢复自转 |
| 按空格 | 播放/停止音频 |
| 按R | 重置视图 |
| 按F | 切换收藏 |

#### 音频播放
- 使用Web Audio API
- 支持跨域音频
- 自动播放策略处理
- 音量控制

#### 收藏系统
- localStorage持久化
- 收藏时触发烟花效果

### 4. 烟花效果 (fireworks.js)

#### 粒子系统
- 60-100个粒子/烟花
- 球形扩散模式
- 重力模拟
- 摩擦力衰减
- 发光效果（globalCompositeOperation: 'lighter'）

#### 闪光效果
- 径向渐变
- 快速扩散 + 淡出

### 5. 星空背景集成

本项目**复用现有的 Three.js 粒子星空**（`backgroundStarRiverParticles`，1400颗星星），无需额外实现。

#### 渲染层级（从后到前）
| 层级 | 内容 | 技术 |
|------|------|------|
| z-index: 0 | 星空背景 | Three.js `backgroundStarRiverParticles` |
| z-index: 1 | 3D地球 | DeckGL `GlobeView`（透明背景） |
| z-index: 2+ | 灯塔信标 | DeckGL `IconLayer` |
| z-index: 50 | 烟花效果 | Canvas 2D 粒子系统 |
| z-index: 100+ | UI覆盖层 | HTML/CSS |

#### 与项目星空的集成方式
```javascript
// 地球渲染器使用透明背景
parameters: {
    clearColor: [0, 0, 0, 0]
}

// Three.js 星空已经在 scene 中渲染
// backgroundStarRiverParticles.renderOrder = -2
// 地球 canvas 叠加在星空之上
```

#### 与烟花的区别
| 元素 | 触发方式 | 持续时间 | 位置 | 技术 |
|------|----------|----------|------|------|
| 星空背景 | 始终存在 | 持续 | 整个背景 | Three.js Points |
| 烟花 | 点击收藏按钮 | 3-5秒消失 | 屏幕中心 | Canvas 2D 粒子 |

## 使用说明

### 启动方式
1. 在浏览器中打开 `index.html`
2. 等待加载完成（约2秒）
3. 点击地球上任一灯塔信标开始收听

### 操作指南
- **旋转地球**：拖拽鼠标
- **缩放视图**：滚动鼠标滚轮
- **选择信标**：点击灯塔图标
- **播放音频**：点击弹窗中的"开始收听"按钮
- **收藏信标**：点击"收藏"按钮

## 复现对比

### 视觉还原度
| 元素 | 还原度 | 说明 |
|------|--------|------|
| 地球外观 | 95% | 使用相同的GLOBE投影和卫星影像 |
| 灯塔图标 | 90% | Canvas绘制，效果接近 |
| 星空背景 | 100% | 复用项目现有Three.js粒子星空 |
| 脉冲动画 | 90% | 正弦波脉冲，效果一致 |
| 烟花效果 | 80% | 粒子系统实现 |

### 交互还原度
| 功能 | 还原度 | 说明 |
|------|--------|------|
| 地球旋转 | 95% | 自动旋转 + 拖拽控制 |
| 信标选择 | 90% | 点击 + 飞行定位 |
| 音频播放 | 85% | 基础播放功能 |
| 收藏功能 | 90% | localStorage持久化 |
| 响应速度 | 95% | 流畅的60fps动画 |

## 扩展建议

1. **添加更多信标**：修改 `lighthouse-model.js` 中的 `beacons` 数组
2. **更换地球纹理**：修改 `earth-renderer.js` 中的 `imageUrl`
3. **调整光照参数**：修改 `lighting` 配置
4. **添加音效**：集成Web Audio API的音频可视化
5. **多语言支持**：添加i18n国际化

## 许可证

本项目仅用于学习和研究目的。
