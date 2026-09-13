'use strict';
/**
 * Stellaflix — 全局出口代理自动识别
 *
 * 让 server 侧的所有 Node fetch（/api/proxy、/api/bangumi/search、音频/封面代理等）
 * 在本机运行着 HTTP / SOCKS 代理时自动经其转发。这等价于“给 Stellaflix 开全局代理”：
 * 只要本机跑着 Clash / V2Ray / 任意代理，并把代理地址注入启动环境变量，
 * 应用的全部网络流量就会走代理（绕开 GFW 对 next.bgm.tv / api.bgm.tv 的封锁）。
 *
 * 支持两种常见形态：
 *   - HTTP(S) 代理：HTTP_PROXY / HTTPS_PROXY（Clash 默认 7890，V2Ray 常见 10809）
 *   - SOCKS5 代理：socks5://...（Clash 默认 7891）
 *
 * 实现：通过 undici 的 EnvHttpProxyAgent（HTTP，自动尊重 NO_PROXY）/ ProxyAgent /
 * Socks5ProxyAgent 注入全局 dispatcher。Node 全局 fetch 会沿用到该 dispatcher。
 *
 * 注意：
 *   - 本模块只负责“识别并启用”，不负责启动/安装代理软件（那属于系统/桌面层）。
 *   - 若未设置任何代理环境变量，则不做任何事，保持默认直连行为（零侵入）。
 *   - NO_PROXY（如 NO_PROXY=localhost,127.0.0.1）会被 EnvHttpProxyAgent 自动尊重，
 *     用于排除内网/本地直连。
 */

function resolveProxyEnv(env) {
  env = env || (typeof process !== 'undefined' ? process.env : {});
  const proxy =
    env.HTTPS_PROXY || env.https_proxy ||
    env.HTTP_PROXY || env.http_proxy || '';
  const noProxy = env.NO_PROXY || env.no_proxy || '';
  return { proxy: String(proxy).trim(), noProxy: String(noProxy).trim() };
}

function pickAgent(undici, proxy) {
  const p = String(proxy || '').trim();
  if (!p) return null;
  if (/^socks5?:\/\//i.test(p)) {
    if (typeof undici.Socks5ProxyAgent !== 'function') {
      throw new Error('undici 版本过低，不支持 Socks5ProxyAgent（需 >=6）：' + p);
    }
    return { agent: new undici.Socks5ProxyAgent(p, { connect: { timeout: 10000 } }), kind: 'socks5' };
  }
  // HTTP(S) 代理：优先 EnvHttpProxyAgent（自动读取 HTTP_PROXY/HTTPS_PROXY/NO_PROXY）
  if (typeof undici.EnvHttpProxyAgent === 'function') {
    return { agent: new undici.EnvHttpProxyAgent({ connect: { timeout: 10000 } }), kind: 'http-env' };
  }
  if (typeof undici.ProxyAgent === 'function') {
    return { agent: new undici.ProxyAgent(p, { connect: { timeout: 10000 } }), kind: 'http' };
  }
  throw new Error('undici 未提供 ProxyAgent，无法启用 HTTP 代理：' + p);
}

/**
 * 尝试按当前环境启用全局出口代理。
 * @param {object} [env] 形如 process.env 的对象；缺省取 process.env
 * @returns {{enabled:boolean, proxy:string, kind:string, error:?string}}
 */
function setupGlobalProxy(env) {
  const out = { enabled: false, proxy: '', kind: '', error: null };
  try {
    const { proxy } = resolveProxyEnv(env);
    if (!proxy) return out; // 未配置代理：保持默认直连
    let undici;
    try {
      undici = require('undici');
    } catch (e) {
      out.error = 'require(undici) 失败：' + (e && e.message);
      return out;
    }
    if (typeof undici.setGlobalDispatcher !== 'function') {
      out.error = 'undici 缺少 setGlobalDispatcher';
      return out;
    }
    const picked = pickAgent(undici, proxy);
    undici.setGlobalDispatcher(picked.agent);
    out.enabled = true;
    out.proxy = proxy;
    out.kind = picked.kind;
  } catch (e) {
    out.error = (e && e.message) || String(e);
  }
  return out;
}

module.exports = { setupGlobalProxy, resolveProxyEnv, pickAgent };
