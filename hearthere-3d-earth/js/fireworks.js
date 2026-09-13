/**
 * 烟花粒子效果系统
 * 用于收藏成功等庆祝动画
 */

class FireworksSystem {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.canvas = null;
        this.ctx = null;
        this.particles = [];
        this.animationFrame = null;
        this.isRunning = false;
        
        this.init();
    }
    
    init() {
        // 创建画布
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 50;
        `;
        this.container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');
        
        // 设置画布大小
        this.resize();
        window.addEventListener('resize', () => this.resize());
        
        // 监听收藏事件
        window.addEventListener('favorite-added', (e) => {
            const { beacon } = e.detail;
            // 在信标位置触发烟花
            this.launchAtPosition(
                window.innerWidth / 2,
                window.innerHeight / 2,
                beacon.color || [255, 215, 0]
            );
        });
        
        // 启动动画循环
        this.start();
    }
    
    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }
    
    // 创建粒子
    createParticle(x, y, color, velocity, size, life) {
        return {
            x,
            y,
            vx: velocity.x + (Math.random() - 0.5) * 2,
            vy: velocity.y + (Math.random() - 0.5) * 2,
            color: color || this.randomColor(),
            size: size || Math.random() * 3 + 1,
            life: life || 1,
            decay: 0.015 + Math.random() * 0.01,
            gravity: 0.1,
            friction: 0.98
        };
    }
    
    // 随机颜色
    randomColor() {
        const colors = [
            [255, 100, 100],
            [100, 255, 100],
            [100, 100, 255],
            [255, 200, 100],
            [200, 100, 255],
            [255, 100, 200],
            [100, 255, 200],
            [255, 215, 0]
        ];
        return colors[Math.floor(Math.random() * colors.length)];
    }
    
    // 发射烟花
    launch(x, y, color) {
        const particleCount = 60 + Math.floor(Math.random() * 40);
        const baseColor = color || this.randomColor();
        
        for (let i = 0; i < particleCount; i++) {
            const angle = (Math.PI * 2 * i) / particleCount;
            const speed = 4 + Math.random() * 4;
            const velocity = {
                x: Math.cos(angle) * speed,
                y: Math.sin(angle) * speed
            };
            
            // 颜色变化
            const particleColor = [
                Math.min(255, Math.max(0, baseColor[0] + (Math.random() - 0.5) * 50)),
                Math.min(255, Math.max(0, baseColor[1] + (Math.random() - 0.5) * 50)),
                Math.min(255, Math.max(0, baseColor[2] + (Math.random() - 0.5) * 50))
            ];
            
            this.particles.push(this.createParticle(x, y, particleColor, velocity));
        }
        
        // 添加闪光效果
        this.createFlash(x, y, baseColor);
    }
    
    // 在指定位置发射
    launchAtPosition(x, y, color) {
        this.launch(x, y, color);
        // 多发射几个增加效果
        setTimeout(() => this.launch(x + 50, y - 30, color), 100);
        setTimeout(() => this.launch(x - 50, y + 30, color), 200);
    }
    
    // 创建闪光效果
    createFlash(x, y, color) {
        const flash = {
            x,
            y,
            radius: 0,
            maxRadius: 80,
            color: color || [255, 255, 255],
            alpha: 1,
            type: 'flash'
        };
        this.particles.push(flash);
    }
    
    // 更新粒子
    update() {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            
            if (p.type === 'flash') {
                // 闪光动画
                p.radius += 5;
                p.alpha -= 0.05;
                if (p.alpha <= 0 || p.radius >= p.maxRadius) {
                    this.particles.splice(i, 1);
                }
            } else {
                // 普通粒子动画
                p.vx *= p.friction;
                p.vy *= p.friction;
                p.vy += p.gravity;
                p.x += p.vx;
                p.y += p.vy;
                p.life -= p.decay;
                p.size *= 0.99;
                
                if (p.life <= 0 || p.size < 0.1) {
                    this.particles.splice(i, 1);
                }
            }
        }
    }
    
    // 绘制粒子
    draw() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // 启用发光效果
        this.ctx.globalCompositeOperation = 'lighter';
        
        for (const p of this.particles) {
            if (p.type === 'flash') {
                // 绘制闪光
                const gradient = this.ctx.createRadialGradient(
                    p.x, p.y, 0,
                    p.x, p.y, p.radius
                );
                gradient.addColorStop(0, `rgba(${p.color.join(',')}, ${p.alpha})`);
                gradient.addColorStop(0.5, `rgba(${p.color.join(',')}, ${p.alpha * 0.5})`);
                gradient.addColorStop(1, `rgba(${p.color.join(',')}, 0)`);
                
                this.ctx.fillStyle = gradient;
                this.ctx.beginPath();
                this.ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
                this.ctx.fill();
            } else {
                // 绘制粒子
                const alpha = p.life;
                this.ctx.fillStyle = `rgba(${p.color.join(',')}, ${alpha})`;
                
                // 发光效果
                this.ctx.shadowBlur = 10;
                this.ctx.shadowColor = `rgba(${p.color.join(',')}, ${alpha})`;
                
                this.ctx.beginPath();
                this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                this.ctx.fill();
                
                // 重置阴影
                this.ctx.shadowBlur = 0;
            }
        }
        
        this.ctx.globalCompositeOperation = 'source-over';
    }
    
    // 动画循环
    animate() {
        this.update();
        this.draw();
        this.animationFrame = requestAnimationFrame(() => this.animate());
    }
    
    // 启动
    start() {
        if (!this.isRunning) {
            this.isRunning = true;
            this.animate();
        }
    }
    
    // 停止
    stop() {
        this.isRunning = false;
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
    }
    
    // 清除所有粒子
    clear() {
        this.particles = [];
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    
    // 销毁
    destroy() {
        this.stop();
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
    }
}

// 导出
window.FireworksSystem = FireworksSystem;
