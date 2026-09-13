/**
 * 3D地球渲染器
 * 基于deck.gl的GLOBE投影模式实现
 * 复现hearthere.live的地球渲染效果
 * 
 * 注意：此渲染器背景透明，与项目现有的Three.js星空背景共用
 */

class EarthRenderer {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.deck = null;
        this.animationFrame = null;
        this.rotationSpeed = 0.02; // 自转速度
        this.currentRotation = 0;
        
        // 地球参数（与原始网站一致）
        this.EARTH_RADIUS = 6370972.0; // 地球半径（米）
        this.GLOBE_RADIUS = 256.0; // 投影半径
        
        // 相机参数
        this.camera = {
            longitude: 0,
            latitude: 20,
            zoom: 3,
            pitch: 0,
            bearing: 0
        };
        
        // 光照参数
        this.lighting = {
            ambient: 0.3,
            diffuse: 0.7,
            specular: 0.2,
            lightPosition: [100, 100, 200],
            lightColor: [255, 250, 240]
        };
        
        this.init();
    }
    
    init() {
        // 初始化DeckGL实例（背景透明，与Three.js星空共用）
        this.deck = new deck.DeckGL({
            canvas: this.canvas,
            initialViewState: {
                longitude: this.camera.longitude,
                latitude: this.camera.latitude,
                zoom: this.camera.zoom,
                pitch: this.camera.pitch,
                bearing: this.camera.bearing
            },
            controller: {
                dragRotate: true,
                dragPan: false,
                scrollZoom: true,
                doubleClickZoom: true,
                touchRotate: true,
                minZoom: 2,
                maxZoom: 8,
                inertia: 0.2
            },
            views: [
                new deck._GlobeView({
                    id: 'globe',
                    repeat: false,
                    near: 0.1,
                    far: 10000
                })
            ],
            layers: this.createLayers(),
            onViewStateChange: this.onViewStateChange.bind(this),
            onHover: this.onHover.bind(this),
            onClick: this.onClick.bind(this),
            useDevicePixels: true,
            pickingRadius: 5,
            // 背景透明，与Three.js星空共用
            parameters: {
                clearColor: [0, 0, 0, 0]
            }
        });
        
        // 设置canvas背景透明
        this.canvas.style.background = 'transparent';
        
        // 启动自动旋转
        this.startAutoRotation();
    }
    
    createLayers() {
        return [
            // 地球基础层 - 使用卫星影像
            new deck.BitmapLayer({
                id: 'earth-base',
                data: [],
                image: 'https://raw.githubusercontent.com/visgl/deck.gl-data/master/website/satellite.png',
                bounds: [-180, -85.051129, 180, 85.051129],
                pickable: false,
                wrapLongitude: true,
                opacity: 1.0,
                desaturate: 0.1,
                tintColor: [255, 255, 255]
            }),
            
            // 地球云层（可选）
            new deck.BitmapLayer({
                id: 'earth-clouds',
                data: [],
                image: 'https://raw.githubusercontent.com/visgl/deck.gl-data/master/website/earlybird.png',
                bounds: [-180, -85.051129, 180, 85.051129],
                pickable: false,
                wrapLongitude: true,
                opacity: 0.15
            })
        ];
    }
    
    // 更新地球纹理
    updateEarthTexture(imageUrl) {
        const layers = this.deck.props.layers;
        const baseLayer = layers.find(l => l.id === 'earth-base');
        if (baseLayer) {
            baseLayer.image = imageUrl;
            this.updateLayers(layers);
        }
    }
    
    // 更新光照参数
    updateLighting(params) {
        Object.assign(this.lighting, params);
        const layers = this.deck.props.layers;
        const lightingLayer = layers.find(l => l.id === 'lighting');
        if (lightingLayer) {
            lightingLayer.ambientIntensity = this.lighting.ambient;
            lightingLayer.diffuseIntensity = this.lighting.diffuse;
            lightingLayer.specularIntensity = this.lighting.specular;
            lightingLayer.lightPosition = this.lighting.lightPosition;
            lightingLayer.lightColor = this.lighting.lightColor;
            this.updateLayers(layers);
        }
    }
    
    // 更新图层
    updateLayers(layers) {
        this.deck.setProps({ layers: [...layers] });
    }
    
    // 视图状态变化回调
    onViewStateChange({ viewState }) {
        this.camera.longitude = viewState.longitude;
        this.camera.latitude = viewState.latitude;
        this.camera.zoom = viewState.zoom;
        this.camera.pitch = viewState.pitch;
        this.camera.bearing = viewState.bearing;
        
        // 触发自定义事件
        window.dispatchEvent(new CustomEvent('camera-change', {
            detail: { ...this.camera }
        }));
    }
    
    // 悬停回调
    onHover(info) {
        if (info.object) {
            document.body.style.cursor = 'pointer';
            window.dispatchEvent(new CustomEvent('beacon-hover', {
                detail: { object: info.object, x: info.x, y: info.y }
            }));
        } else {
            document.body.style.cursor = 'grab';
        }
    }
    
    // 点击回调
    onClick(info) {
        if (info.object) {
            window.dispatchEvent(new CustomEvent('beacon-click', {
                detail: { object: info.object, x: info.x, y: info.y }
            }));
        }
    }
    
    // 启动自动旋转
    startAutoRotation() {
        const animate = () => {
            this.currentRotation += this.rotationSpeed;
            this.camera.longitude = (this.currentRotation % 360);
            
            this.deck.setProps({
                viewState: {
                    ...this.deck.props.viewState,
                    longitude: this.camera.longitude
                }
            });
            
            this.animationFrame = requestAnimationFrame(animate);
        };
        animate();
    }
    
    // 停止自动旋转
    stopAutoRotation() {
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
    }
    
    // 设置旋转速度
    setRotationSpeed(speed) {
        this.rotationSpeed = speed;
    }
    
    // 飞行到指定位置
    flyTo(longitude, latitude, zoom = 5, duration = 2000) {
        const startState = { ...this.deck.props.viewState };
        const endState = {
            longitude,
            latitude,
            zoom,
            pitch: 0,
            bearing: 0
        };
        
        const startTime = performance.now();
        
        const animate = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            // 使用缓动函数
            const eased = this.easeInOutCubic(progress);
            
            const currentState = {
                longitude: startState.longitude + (endState.longitude - startState.longitude) * eased,
                latitude: startState.latitude + (endState.latitude - startState.latitude) * eased,
                zoom: startState.zoom + (endState.zoom - startState.zoom) * eased,
                pitch: startState.pitch + (endState.pitch - startState.pitch) * eased,
                bearing: startState.bearing + (endState.bearing - startState.bearing) * eased
            };
            
            this.deck.setProps({ viewState: currentState });
            
            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        };
        
        requestAnimationFrame(animate);
    }
    
    // 缓动函数
    easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }
    
    // 获取当前视图状态
    getViewState() {
        return { ...this.deck.props.viewState };
    }
    
    // 销毁渲染器
    destroy() {
        this.stopAutoRotation();
        if (this.deck) {
            this.deck.finalize();
            this.deck = null;
        }
    }
}

// 导出
window.EarthRenderer = EarthRenderer;
