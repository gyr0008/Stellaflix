/**
 * 交互系统
 * 处理用户与3D场景的所有交互行为
 * 包括：点击、悬停、拖拽、音频播放、相机控制
 */

class InteractionManager {
    constructor(earthRenderer, lighthouseModel) {
        this.earthRenderer = earthRenderer;
        this.lighthouseModel = lighthouseModel;
        
        // 状态
        this.state = {
            selectedBeacon: null,
            hoveredBeacon: null,
            isDragging: false,
            lastMousePosition: { x: 0, y: 0 },
            audioPlaying: false,
            currentAudio: null
        };
        
        // DOM元素
        this.popup = document.getElementById('beaconPopup');
        this.beaconName = document.getElementById('beaconName');
        this.beaconStatus = document.getElementById('beaconStatus');
        this.beaconDesc = document.getElementById('beaconDesc');
        this.btnListen = document.getElementById('btnListen');
        this.btnFavorite = document.getElementById('btnFavorite');
        
        // 音频上下文
        this.audioContext = null;
        this.audioElement = null;
        
        this.init();
    }
    
    init() {
        // 绑定事件监听
        this.bindEvents();
        // 初始化音频
        this.initAudio();
    }
    
    bindEvents() {
        // 信标点击事件
        window.addEventListener('beacon-click', (e) => {
            this.onBeaconClick(e.detail);
        });
        
        // 信标悬停事件
        window.addEventListener('beacon-hover', (e) => {
            this.onBeaconHover(e.detail);
        });
        
        // 相机变化事件
        window.addEventListener('camera-change', (e) => {
            this.onCameraChange(e.detail);
        });
        
        // 按钮事件
        this.btnListen.addEventListener('click', () => this.onListenClick());
        this.btnFavorite.addEventListener('click', () => this.onFavoriteClick());
        
        // 键盘事件
        document.addEventListener('keydown', (e) => this.onKeyDown(e));
        
        // 窗口大小变化
        window.addEventListener('resize', () => this.onResize());
        
        // 鼠标事件（用于拖拽检测）
        const canvas = this.earthRenderer.canvas;
        canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
        canvas.addEventListener('mouseleave', (e) => this.onMouseLeave(e));
        
        // 触摸事件支持
        canvas.addEventListener('touchstart', (e) => this.onTouchStart(e));
        canvas.addEventListener('touchmove', (e) => this.onTouchMove(e));
        canvas.addEventListener('touchend', (e) => this.onTouchEnd(e));
        
        // 滚轮缩放
        canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
        
        // 点击弹窗外部关闭
        document.addEventListener('click', (e) => {
            if (!this.popup.contains(e.target) && !e.target.closest('.beacon-marker')) {
                this.hidePopup();
            }
        });
    }
    
    // 初始化音频系统
    initAudio() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.audioElement = new Audio();
            this.audioElement.crossOrigin = 'anonymous';
            
            // 音频事件
            this.audioElement.addEventListener('play', () => {
                this.state.audioPlaying = true;
                this.updateListenButton();
            });
            
            this.audioElement.addEventListener('pause', () => {
                this.state.audioPlaying = false;
                this.updateListenButton();
            });
            
            this.audioElement.addEventListener('ended', () => {
                this.state.audioPlaying = false;
                this.updateListenButton();
            });
            
            this.audioElement.addEventListener('error', (e) => {
                console.warn('音频加载失败:', e);
                this.state.audioPlaying = false;
                this.updateListenButton();
            });
        } catch (e) {
            console.warn('音频上下文初始化失败:', e);
        }
    }
    
    // 信标点击处理
    onBeaconClick(detail) {
        const { object, x, y } = detail;
        
        // 更新选中状态
        this.state.selectedBeacon = object;
        
        // 显示弹窗
        this.showPopup(object, x, y);
        
        // 飞行到信标位置
        this.earthRenderer.flyTo(
            object.position[0],
            object.position[1],
            5,
            1500
        );
        
        // 停止自动旋转
        this.earthRenderer.stopAutoRotation();
        
        // 触发事件
        window.dispatchEvent(new CustomEvent('beacon-selected', {
            detail: { beacon: object }
        }));
    }
    
    // 信标悬停处理
    onBeaconHover(detail) {
        const { object, x, y } = detail;
        
        this.state.hoveredBeacon = object;
        
        if (object) {
            // 显示悬停提示
            this.showTooltip(object, x, y);
        } else {
            this.hideTooltip();
        }
    }
    
    // 相机变化处理
    onCameraChange(camera) {
        // 根据相机高度调整信标大小
        const zoom = camera.zoom;
        const iconScale = Math.max(0.5, Math.min(1.5, zoom / 4));
        
        // 触发相机变化事件
        window.dispatchEvent(new CustomEvent('camera-zoom-change', {
            detail: { zoom, iconScale }
        }));
    }
    
    // 显示信标详情弹窗
    showPopup(beacon, x, y) {
        this.beaconName.textContent = beacon.name;
        this.beaconDesc.textContent = beacon.description;
        
        // 更新状态显示
        this.beaconStatus.textContent = beacon.status === 'live' ? 'LIVE' : 'OFFLINE';
        this.beaconStatus.className = 'beacon-status' + (beacon.status !== 'live' ? ' offline' : '');
        
        // 定位弹窗
        const padding = 20;
        let popupX = x + 30;
        let popupY = y - 50;
        
        // 边界检测
        const popupRect = this.popup.getBoundingClientRect();
        if (popupX + popupRect.width > window.innerWidth - padding) {
            popupX = x - popupRect.width - 30;
        }
        if (popupY + popupRect.height > window.innerHeight - padding) {
            popupY = window.innerHeight - popupRect.height - padding;
        }
        if (popupY < padding) {
            popupY = padding;
        }
        
        this.popup.style.left = popupX + 'px';
        this.popup.style.top = popupY + 'px';
        this.popup.classList.add('active');
    }
    
    // 隐藏弹窗
    hidePopup() {
        this.popup.classList.remove('active');
        this.state.selectedBeacon = null;
    }
    
    // 显示悬停提示
    showTooltip(beacon, x, y) {
        let tooltip = document.querySelector('.beacon-tooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.className = 'beacon-tooltip';
            tooltip.style.cssText = `
                position: absolute;
                background: rgba(0, 0, 0, 0.8);
                color: white;
                padding: 6px 12px;
                border-radius: 4px;
                font-size: 12px;
                pointer-events: none;
                z-index: 150;
                white-space: nowrap;
            `;
            document.body.appendChild(tooltip);
        }
        
        tooltip.textContent = beacon.name;
        tooltip.style.left = (x + 15) + 'px';
        tooltip.style.top = (y - 30) + 'px';
        tooltip.style.display = 'block';
    }
    
    // 隐藏悬停提示
    hideTooltip() {
        const tooltip = document.querySelector('.beacon-tooltip');
        if (tooltip) {
            tooltip.style.display = 'none';
        }
    }
    
    // 收听按钮点击
    onListenClick() {
        if (!this.state.selectedBeacon) return;
        
        if (this.state.audioPlaying) {
            this.stopAudio();
        } else {
            this.playAudio(this.state.selectedBeacon);
        }
    }
    
    // 收藏按钮点击
    onFavoriteClick() {
        if (!this.state.selectedBeacon) return;
        
        const beacon = this.state.selectedBeacon;
        const isFavorite = this.isFavorite(beacon.id);
        
        if (isFavorite) {
            this.removeFavorite(beacon.id);
            this.btnFavorite.textContent = '收藏';
        } else {
            this.addFavorite(beacon.id);
            this.btnFavorite.textContent = '已收藏';
        }
        
        // 触发烟花效果
        if (!isFavorite) {
            window.dispatchEvent(new CustomEvent('favorite-added', {
                detail: { beacon }
            }));
        }
    }
    
    // 播放音频
    async playAudio(beacon) {
        if (!this.audioElement) return;
        
        try {
            // 恢复音频上下文（浏览器自动播放策略）
            if (this.audioContext && this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            
            // 设置音频源
            this.audioElement.src = beacon.audioUrl;
            this.audioElement.volume = beacon.intensity || 1.0;
            
            await this.audioElement.play();
            this.state.currentAudio = beacon.id;
        } catch (e) {
            console.warn('音频播放失败:', e);
            // 显示提示
            this.showNotification('音频加载失败，请稍后重试');
        }
    }
    
    // 停止音频
    stopAudio() {
        if (this.audioElement) {
            this.audioElement.pause();
            this.audioElement.currentTime = 0;
        }
        this.state.audioPlaying = false;
        this.state.currentAudio = null;
        this.updateListenButton();
    }
    
    // 更新收听按钮状态
    updateListenButton() {
        if (this.btnListen) {
            this.btnListen.textContent = this.state.audioPlaying ? '停止播放' : '开始收听';
        }
    }
    
    // 收藏相关
    getFavorites() {
        try {
            return JSON.parse(localStorage.getItem('hearthere-favorites') || '[]');
        } catch {
            return [];
        }
    }
    
    isFavorite(beaconId) {
        return this.getFavorites().includes(beaconId);
    }
    
    addFavorite(beaconId) {
        const favorites = this.getFavorites();
        if (!favorites.includes(beaconId)) {
            favorites.push(beaconId);
            localStorage.setItem('hearthere-favorites', JSON.stringify(favorites));
        }
    }
    
    removeFavorite(beaconId) {
        const favorites = this.getFavorites().filter(id => id !== beaconId);
        localStorage.setItem('hearthere-favorites', JSON.stringify(favorites));
    }
    
    // 键盘事件
    onKeyDown(e) {
        switch (e.key) {
            case 'Escape':
                this.hidePopup();
                this.stopAudio();
                // 恢复自动旋转
                this.earthRenderer.startAutoRotation();
                break;
            case ' ':
                e.preventDefault();
                if (this.state.selectedBeacon) {
                    this.onListenClick();
                }
                break;
            case 'r':
            case 'R':
                // 重置视图
                this.resetView();
                break;
            case 'f':
            case 'F':
                // 切换收藏
                if (this.state.selectedBeacon) {
                    this.onFavoriteClick();
                }
                break;
        }
    }
    
    // 重置视图
    resetView() {
        this.earthRenderer.flyTo(0, 20, 3, 2000);
        this.earthRenderer.startAutoRotation();
        this.hidePopup();
    }
    
    // 鼠标事件
    onMouseDown(e) {
        this.state.isDragging = true;
        this.state.lastMousePosition = { x: e.clientX, y: e.clientY };
        this.earthRenderer.stopAutoRotation();
    }
    
    onMouseMove(e) {
        if (this.state.isDragging) {
            const deltaX = e.clientX - this.state.lastMousePosition.x;
            const deltaY = e.clientY - this.state.lastMousePosition.y;
            
            // 更新相机位置
            const viewState = this.earthRenderer.getViewState();
            this.earthRenderer.deck.setProps({
                viewState: {
                    ...viewState,
                    longitude: viewState.longitude - deltaX * 0.2,
                    latitude: Math.max(-85, Math.min(85, viewState.latitude + deltaY * 0.2))
                }
            });
            
            this.state.lastMousePosition = { x: e.clientX, y: e.clientY };
        }
    }
    
    onMouseUp(e) {
        if (this.state.isDragging) {
            this.state.isDragging = false;
            // 延迟恢复自动旋转
            setTimeout(() => {
                if (!this.state.selectedBeacon) {
                    this.earthRenderer.startAutoRotation();
                }
            }, 3000);
        }
    }
    
    onMouseLeave(e) {
        if (this.state.isDragging) {
            this.state.isDragging = false;
        }
        this.hideTooltip();
    }
    
    // 触摸事件
    onTouchStart(e) {
        if (e.touches.length === 1) {
            this.state.isDragging = true;
            this.state.lastMousePosition = {
                x: e.touches[0].clientX,
                y: e.touches[0].clientY
            };
            this.earthRenderer.stopAutoRotation();
        }
    }
    
    onTouchMove(e) {
        if (this.state.isDragging && e.touches.length === 1) {
            e.preventDefault();
            const deltaX = e.touches[0].clientX - this.state.lastMousePosition.x;
            const deltaY = e.touches[0].clientY - this.state.lastMousePosition.y;
            
            const viewState = this.earthRenderer.getViewState();
            this.earthRenderer.deck.setProps({
                viewState: {
                    ...viewState,
                    longitude: viewState.longitude - deltaX * 0.2,
                    latitude: Math.max(-85, Math.min(85, viewState.latitude + deltaY * 0.2))
                }
            });
            
            this.state.lastMousePosition = {
                x: e.touches[0].clientX,
                y: e.touches[0].clientY
            };
        }
    }
    
    onTouchEnd(e) {
        this.state.isDragging = false;
        setTimeout(() => {
            if (!this.state.selectedBeacon) {
                this.earthRenderer.startAutoRotation();
            }
        }, 3000);
    }
    
    // 滚轮缩放
    onWheel(e) {
        e.preventDefault();
        const viewState = this.earthRenderer.getViewState();
        const delta = e.deltaY > 0 ? -0.5 : 0.5;
        
        this.earthRenderer.deck.setProps({
            viewState: {
                ...viewState,
                zoom: Math.max(2, Math.min(8, viewState.zoom + delta))
            }
        });
    }
    
    // 窗口大小变化
    onResize() {
        if (this.earthRenderer.deck) {
            this.earthRenderer.deck.redraw();
        }
    }
    
    // 显示通知
    showNotification(message) {
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            bottom: 100px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 14px;
            z-index: 1000;
            animation: fadeInOut 3s ease-in-out forwards;
        `;
        notification.textContent = message;
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.remove();
        }, 3000);
    }
    
    // 销毁
    destroy() {
        this.stopAudio();
        if (this.audioContext) {
            this.audioContext.close();
        }
    }
}

// 添加动画样式
const style = document.createElement('style');
style.textContent = `
    @keyframes fadeInOut {
        0% { opacity: 0; transform: translateX(-50%) translateY(20px); }
        10% { opacity: 1; transform: translateX(-50%) translateY(0); }
        90% { opacity: 1; transform: translateX(-50%) translateY(0); }
        100% { opacity: 0; transform: translateX(-50%) translateY(-20px); }
    }
`;
document.head.appendChild(style);

// 导出
window.InteractionManager = InteractionManager;
