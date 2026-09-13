/**
 * 灯塔模型与信标系统
 * 复现hearthere.live的灯塔3D模型和信标交互
 */

class LighthouseModel {
    constructor() {
        this.beacons = [];
        this.lighthouses = [];
        this.iconMapping = {};
        this.pulseAnimations = new Map();
        
        // 灯塔纹理配置
        this.lighthouseTextures = {
            default: this.createLighthouseTexture(),
            active: this.createActiveLighthouseTexture(),
            selected: this.createSelectedLighthouseTexture()
        };
        
        this.init();
    }
    
    init() {
        // 初始化信标数据
        this.loadBeaconData();
        // 创建图标映射
        this.createIconMapping();
    }
    
    // 加载信标数据
    loadBeaconData() {
        // 模拟信标数据（实际应从API获取）
        this.beacons = [
            {
                id: 'beacon-1',
                name: '东京灯塔',
                position: [139.6917, 35.6895],
                description: '来自东京都市的喧嚣与宁静',
                status: 'live',
                audioUrl: 'https://example.com/audio/tokyo.mp3',
                color: [255, 100, 100],
                intensity: 1.0
            },
            {
                id: 'beacon-2',
                name: '纽约灯塔',
                position: [-74.0060, 40.7128],
                description: '不夜城的脉搏与节奏',
                status: 'live',
                audioUrl: 'https://example.com/audio/newyork.mp3',
                color: [100, 255, 100],
                intensity: 0.9
            },
            {
                id: 'beacon-3',
                name: '伦敦灯塔',
                position: [-0.1276, 51.5074],
                description: '泰晤士河畔的古老回声',
                status: 'live',
                audioUrl: 'https://example.com/audio/london.mp3',
                color: [100, 100, 255],
                intensity: 0.85
            },
            {
                id: 'beacon-4',
                name: '悉尼灯塔',
                position: [151.2093, -33.8688],
                description: '南半球的海浪与风声',
                status: 'live',
                audioUrl: 'https://example.com/audio/sydney.mp3',
                color: [255, 200, 100],
                intensity: 0.95
            },
            {
                id: 'beacon-5',
                name: '巴黎灯塔',
                position: [2.3522, 48.8566],
                description: '浪漫之都的街头乐章',
                status: 'live',
                audioUrl: 'https://example.com/audio/paris.mp3',
                color: [200, 100, 255],
                intensity: 0.88
            },
            {
                id: 'beacon-6',
                name: '开罗灯塔',
                position: [31.2357, 30.0444],
                description: '尼罗河畔的千年故事',
                status: 'live',
                audioUrl: 'https://example.com/audio/cairo.mp3',
                color: [255, 150, 50],
                intensity: 0.82
            },
            {
                id: 'beacon-7',
                name: '里约灯塔',
                position: [-43.1729, -22.9068],
                description: '桑巴之城的热情节拍',
                status: 'live',
                audioUrl: 'https://example.com/audio/rio.mp3',
                color: [50, 255, 200],
                intensity: 0.92
            },
            {
                id: 'beacon-8',
                name: '莫斯科灯塔',
                position: [37.6173, 55.7558],
                description: '北极圈附近的冰雪之音',
                status: 'live',
                audioUrl: 'https://example.com/audio/moscow.mp3',
                color: [150, 150, 255],
                intensity: 0.78
            },
            {
                id: 'beacon-9',
                name: '开普敦灯塔',
                position: [18.4241, -33.9249],
                description: '非洲大陆南端的海风',
                status: 'live',
                audioUrl: 'https://example.com/audio/capetown.mp3',
                color: [255, 100, 200],
                intensity: 0.86
            },
            {
                id: 'beacon-10',
                name: '迪拜灯塔',
                position: [55.2708, 25.2048],
                description: '沙漠中的现代奇迹',
                status: 'live',
                audioUrl: 'https://example.com/audio/dubai.mp3',
                color: [255, 215, 0],
                intensity: 0.9
            }
        ];
    }
    
    // 创建灯塔纹理（使用Canvas绘制）
    createLighthouseTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        
        // 绘制灯塔底座
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.moveTo(20, 50);
        ctx.lineTo(44, 50);
        ctx.lineTo(40, 35);
        ctx.lineTo(24, 35);
        ctx.closePath();
        ctx.fill();
        
        // 绘制灯塔塔身
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(26, 35);
        ctx.lineTo(38, 35);
        ctx.lineTo(35, 15);
        ctx.lineTo(29, 15);
        ctx.closePath();
        ctx.fill();
        
        // 绘制灯塔顶部
        ctx.fillStyle = '#ff4444';
        ctx.beginPath();
        ctx.arc(32, 12, 6, 0, Math.PI * 2);
        ctx.fill();
        
        // 绘制灯光效果
        ctx.fillStyle = 'rgba(255, 200, 100, 0.6)';
        ctx.beginPath();
        ctx.arc(32, 12, 10, 0, Math.PI * 2);
        ctx.fill();
        
        return canvas;
    }
    
    // 创建激活状态的灯塔纹理
    createActiveLighthouseTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        
        // 发光效果
        const gradient = ctx.createRadialGradient(32, 12, 0, 32, 12, 30);
        gradient.addColorStop(0, 'rgba(255, 200, 100, 1)');
        gradient.addColorStop(0.5, 'rgba(255, 150, 50, 0.5)');
        gradient.addColorStop(1, 'rgba(255, 100, 0, 0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 64, 64);
        
        // 灯塔底座
        ctx.fillStyle = '#444';
        ctx.beginPath();
        ctx.moveTo(20, 50);
        ctx.lineTo(44, 50);
        ctx.lineTo(40, 35);
        ctx.lineTo(24, 35);
        ctx.closePath();
        ctx.fill();
        
        // 灯塔塔身
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(26, 35);
        ctx.lineTo(38, 35);
        ctx.lineTo(35, 15);
        ctx.lineTo(29, 15);
        ctx.closePath();
        ctx.fill();
        
        // 灯塔顶部
        ctx.fillStyle = '#ff0000';
        ctx.beginPath();
        ctx.arc(32, 12, 6, 0, Math.PI * 2);
        ctx.fill();
        
        return canvas;
    }
    
    // 创建选中状态的灯塔纹理
    createSelectedLighthouseTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        
        // 脉冲光环
        ctx.strokeStyle = 'rgba(100, 200, 255, 0.8)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(32, 32, 28, 0, Math.PI * 2);
        ctx.stroke();
        
        ctx.strokeStyle = 'rgba(100, 200, 255, 0.4)';
        ctx.beginPath();
        ctx.arc(32, 32, 22, 0, Math.PI * 2);
        ctx.stroke();
        
        // 灯塔底座
        ctx.fillStyle = '#555';
        ctx.beginPath();
        ctx.moveTo(20, 50);
        ctx.lineTo(44, 50);
        ctx.lineTo(40, 35);
        ctx.lineTo(24, 35);
        ctx.closePath();
        ctx.fill();
        
        // 灯塔塔身
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(26, 35);
        ctx.lineTo(38, 35);
        ctx.lineTo(35, 15);
        ctx.lineTo(29, 15);
        ctx.closePath();
        ctx.fill();
        
        // 灯塔顶部
        ctx.fillStyle = '#00ffff';
        ctx.beginPath();
        ctx.arc(32, 12, 6, 0, Math.PI * 2);
        ctx.fill();
        
        return canvas;
    }
    
    // 创建图标映射
    createIconMapping() {
        this.beacons.forEach((beacon, index) => {
            this.iconMapping[`lighthouse-${beacon.id}`] = {
                url: this.lighthouseTextures.default.toDataURL(),
                width: 64,
                height: 64,
                anchorY: 64,
                mask: true
            };
        });
    }
    
    // 创建灯塔IconLayer
    createLighthouseLayer() {
        return new deck.IconLayer({
            id: 'lighthouses',
            data: this.beacons,
            pickable: true,
            iconAtlas: this.createIconAtlas(),
            iconMapping: this.iconMapping,
            getPosition: d => d.position,
            getIcon: d => `lighthouse-${d.id}`,
            getSize: d => d.status === 'live' ? 40 : 30,
            getColor: d => d.color,
            sizeScale: 1,
            sizeMinPixels: 20,
            sizeMaxPixels: 60,
            billboard: true,
            alphaCutoff: 0.05,
            onIconError: (error) => {
                console.warn('图标加载失败:', error);
            }
        });
    }
    
    // 创建图标图集
    createIconAtlas() {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        const ctx = canvas.getContext('2d');
        
        // 绘制所有灯塔图标到图集
        this.beacons.forEach((beacon, index) => {
            const x = (index % 8) * 64;
            const y = Math.floor(index / 8) * 64;
            ctx.drawImage(this.lighthouseTextures.default, x, y);
        });
        
        return canvas;
    }
    
    // 创建脉冲动画层
    createPulseLayer() {
        return new deck.ScatterplotLayer({
            id: 'pulse-layer',
            data: this.beacons.filter(b => b.status === 'live'),
            pickable: false,
            stroked: true,
            filled: true,
            getPosition: d => d.position,
            getRadius: d => this.getPulseRadius(d.id),
            getFillColor: [...d.color, 50],
            getLineColor: [...d.color, 150],
            getLineWidth: 2,
            radiusScale: 1,
            radiusMinPixels: 10,
            radiusMaxPixels: 30,
            lineWidthMinPixels: 1,
            lineWidthMaxPixels: 3,
            billboard: true
        });
    }
    
    // 获取脉冲半径（用于动画）
    getPulseRadius(beaconId) {
        const animation = this.pulseAnimations.get(beaconId);
        if (!animation) {
            return 20;
        }
        return animation.currentRadius;
    }
    
    // 启动脉冲动画
    startPulseAnimation(beaconId) {
        const beacon = this.beacons.find(b => b.id === beaconId);
        if (!beacon) return;
        
        const animation = {
            startTime: performance.now(),
            duration: 2000,
            minRadius: 15,
            maxRadius: 35,
            currentRadius: 15
        };
        
        this.pulseAnimations.set(beaconId, animation);
        
        const animate = () => {
            const anim = this.pulseAnimations.get(beaconId);
            if (!anim) return;
            
            const elapsed = performance.now() - anim.startTime;
            const progress = (elapsed % anim.duration) / anim.duration;
            
            // 正弦波脉冲
            anim.currentRadius = anim.minRadius + 
                (anim.maxRadius - anim.minRadius) * 
                (0.5 + 0.5 * Math.sin(progress * Math.PI * 2));
            
            this.pulseAnimations.set(beaconId, anim);
            
            if (this.pulseAnimations.has(beaconId)) {
                requestAnimationFrame(animate);
            }
        };
        
        requestAnimationFrame(animate);
    }
    
    // 停止脉冲动画
    stopPulseAnimation(beaconId) {
        this.pulseAnimations.delete(beaconId);
    }
    
    // 获取信标数据
    getBeacon(id) {
        return this.beacons.find(b => b.id === id);
    }
    
    // 获取所有信标
    getAllBeacons() {
        return [...this.beacons];
    }
    
    // 更新信标状态
    updateBeaconStatus(id, status) {
        const beacon = this.beacons.find(b => b.id === id);
        if (beacon) {
            beacon.status = status;
            if (status === 'live') {
                this.startPulseAnimation(id);
            } else {
                this.stopPulseAnimation(id);
            }
        }
    }
    
    // 添加新信标
    addBeacon(beaconData) {
        const newBeacon = {
            id: `beacon-${Date.now()}`,
            status: 'live',
            color: [255, 255, 255],
            intensity: 1.0,
            ...beaconData
        };
        this.beacons.push(newBeacon);
        this.startPulseAnimation(newBeacon.id);
        return newBeacon;
    }
    
    // 移除信标
    removeBeacon(id) {
        this.stopPulseAnimation(id);
        this.beacons = this.beacons.filter(b => b.id !== id);
    }
    
    // 获取信标统计信息
    getStats() {
        const live = this.beacons.filter(b => b.status === 'live').length;
        const offline = this.beacons.filter(b => b.status === 'offline').length;
        return {
            total: this.beacons.length,
            live,
            offline
        };
    }
}

// 导出
window.LighthouseModel = LighthouseModel;
