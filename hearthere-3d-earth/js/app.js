/**
 * HearThere 3D Earth - 主应用入口
 * 复现 hearthere.live 的完整交互体验
 * 
 * 集成说明：
 * - 背景：使用项目现有的 Three.js 星空（backgroundStarRiverParticles）
 * - 中景：DeckGL 3D 地球渲染（透明背景）
 * - 前景：灯塔信标 + UI 覆盖层
 */

class HearThereApp {
    constructor() {
        this.earthRenderer = null;
        this.lighthouseModel = null;
        this.interactionManager = null;
        this.fireworksSystem = null;
        
        this.loadingOverlay = document.getElementById('loadingOverlay');
        
        this.init();
    }
    
    async init() {
        try {
            // 等待 Three.js 场景准备完成
            await this.waitForThreeJS();
            
            // 初始化3D地球渲染器（透明背景，叠加在Three.js星空之上）
            this.earthRenderer = new EarthRenderer('deck-canvas');
            
            // 初始化灯塔模型
            this.lighthouseModel = new LighthouseModel();
            
            // 初始化交互管理器
            this.interactionManager = new InteractionManager(
                this.earthRenderer,
                this.lighthouseModel
            );
            
            // 初始化烟花系统
            this.fireworksSystem = new FireworksSystem('fireworks');
            
            // 添加灯塔图层到地球
            this.addLighthouseLayers();
            
            // 绑定UI事件
            this.bindUIEvents();
            
            // 模拟加载完成后隐藏加载动画
            await this.simulateLoading();
            
            // 显示欢迎提示
            this.showWelcomeMessage();
            
            console.log('HearThere 3D Earth 初始化完成');
            
        } catch (error) {
            console.error('初始化失败:', error);
            this.showErrorMessage('初始化失败，请刷新页面重试');
        }
    }
    
    // 等待 Three.js 场景准备完成
    waitForThreeJS() {
        return new Promise((resolve) => {
            // 检查 Three.js 是否已加载
            if (typeof THREE !== 'undefined' && typeof scene !== 'undefined') {
                resolve();
                return;
            }
            
            // 等待 Three.js 加载
            const checkInterval = setInterval(() => {
                if (typeof THREE !== 'undefined' && typeof scene !== 'undefined') {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 100);
            
            // 超时处理
            setTimeout(() => {
                clearInterval(checkInterval);
                console.warn('Three.js 加载超时，继续初始化');
                resolve();
            }, 10000);
        });
    }
    
    // 添加灯塔图层
    addLighthouseLayers() {
        const layers = this.earthRenderer.deck.props.layers;
        
        // 添加灯塔图标层
        layers.push(this.lighthouseModel.createLighthouseLayer());
        
        // 添加脉冲动画层
        layers.push(this.lighthouseModel.createPulseLayer());
        
        this.earthRenderer.updateLayers(layers);
        
        // 启动所有信标的脉冲动画
        this.lighthouseModel.getAllBeacons().forEach(beacon => {
            if (beacon.status === 'live') {
                this.lighthouseModel.startPulseAnimation(beacon.id);
            }
        });
    }
    
    // 绑定UI事件
    bindUIEvents() {
        // 刷新按钮
        const refreshBtn = document.getElementById('refreshBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => this.refreshBeacons());
        }
        
        // 定位按钮
        const locateBtn = document.getElementById('locateBtn');
        if (locateBtn) {
            locateBtn.addEventListener('click', () => this.locateUser());
        }
        
        // 统计面板
        window.addEventListener('beacon-selected', () => {
            this.updateStats();
        });
    }
    
    // 模拟加载
    simulateLoading() {
        return new Promise(resolve => {
            setTimeout(() => {
                this.loadingOverlay.classList.add('hidden');
                resolve();
            }, 2000);
        });
    }
    
    // 显示欢迎消息
    showWelcomeMessage() {
        const stats = this.lighthouseModel.getStats();
        const message = `🌍 已连接 ${stats.live} 个声音信标`;
        
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            top: 100px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(100, 150, 255, 0.9);
            color: white;
            padding: 12px 24px;
            border-radius: 25px;
            font-size: 14px;
            z-index: 1000;
            animation: welcomeFade 4s ease-in-out forwards;
            box-shadow: 0 4px 20px rgba(100, 150, 255, 0.4);
        `;
        toast.textContent = message;
        document.body.appendChild(toast);
        
        setTimeout(() => {
            toast.remove();
        }, 4000);
    }
    
    // 显示错误消息
    showErrorMessage(message) {
        const errorDiv = document.createElement('div');
        errorDiv.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(255, 100, 100, 0.9);
            color: white;
            padding: 20px 40px;
            border-radius: 12px;
            font-size: 16px;
            z-index: 1000;
        `;
        errorDiv.textContent = message;
        document.body.appendChild(errorDiv);
        
        setTimeout(() => {
            errorDiv.remove();
        }, 5000);
    }
    
    // 刷新信标
    refreshBeacons() {
        // 模拟刷新动画
        const btn = document.getElementById('refreshBtn');
        if (btn) {
            btn.style.transform = 'rotate(360deg)';
            btn.style.transition = 'transform 0.5s';
            setTimeout(() => {
                btn.style.transform = '';
                btn.style.transition = '';
            }, 500);
        }
        
        // 更新信标状态
        this.lighthouseModel.getAllBeacons().forEach(beacon => {
            // 随机更新一些信标状态
            if (Math.random() > 0.1) {
                this.lighthouseModel.updateBeaconStatus(beacon.id, 'live');
            } else {
                this.lighthouseModel.updateBeaconStatus(beacon.id, 'offline');
            }
        });
        
        // 刷新图层
        this.addLighthouseLayers();
        
        // 更新统计
        this.updateStats();
        
        this.showToast('信标列表已更新');
    }
    
    // 定位用户
    locateUser() {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const { latitude, longitude } = position.coords;
                    this.earthRenderer.flyTo(longitude, latitude, 5, 2000);
                    this.showToast('已定位到您的位置');
                },
                (error) => {
                    console.warn('定位失败:', error);
                    this.showToast('无法获取位置信息，使用默认位置');
                    // 使用默认位置（东京）
                    this.earthRenderer.flyTo(139.6917, 35.6895, 5, 2000);
                },
                {
                    enableHighAccuracy: true,
                    timeout: 10000,
                    maximumAge: 60000
                }
            );
        } else {
            this.showToast('您的浏览器不支持定位功能');
        }
    }
    
    // 更新统计
    updateStats() {
        const statsPanel = document.getElementById('statsPanel');
        if (statsPanel) {
            const stats = this.lighthouseModel.getStats();
            statsPanel.innerHTML = `
                <div class="stat-item">
                    <span class="stat-value">${stats.total}</span>
                    <span class="stat-label">信标总数</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value live">${stats.live}</span>
                    <span class="stat-label">在线</span>
                </div>
                <div class="stat-item">
                    <span class="stat-value offline">${stats.offline}</span>
                    <span class="stat-label">离线</span>
                </div>
            `;
        }
    }
    
    // 显示提示
    showToast(message) {
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            bottom: 100px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 10px 20px;
            border-radius: 20px;
            font-size: 13px;
            z-index: 1000;
            animation: toastFade 3s ease-in-out forwards;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);
        
        setTimeout(() => {
            toast.remove();
        }, 3000);
    }
    
    // 销毁应用
    destroy() {
        if (this.fireworksSystem) {
            this.fireworksSystem.destroy();
        }
        if (this.interactionManager) {
            this.interactionManager.destroy();
        }
        if (this.earthRenderer) {
            this.earthRenderer.destroy();
        }
    }
}

// 添加CSS动画
const style = document.createElement('style');
style.textContent = `
    @keyframes welcomeFade {
        0% { opacity: 0; transform: translateX(-50%) translateY(-20px); }
        15% { opacity: 1; transform: translateX(-50%) translateY(0); }
        85% { opacity: 1; transform: translateX(-50%) translateY(0); }
        100% { opacity: 0; transform: translateX(-50%) translateY(-20px); }
    }
    
    @keyframes toastFade {
        0% { opacity: 0; transform: translateX(-50%) translateY(10px); }
        10% { opacity: 1; transform: translateX(-50%) translateY(0); }
        80% { opacity: 1; transform: translateX(-50%) translateY(0); }
        100% { opacity: 0; transform: translateX(-50%) translateY(-10px); }
    }
`;
document.head.appendChild(style);

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    window.hearThereApp = new HearThereApp();
});

// 导出
window.HearThereApp = HearThereApp;
