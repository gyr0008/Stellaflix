const RIGHTS_RESTRICTIONS = new Set([
  'login_required',
  'vip_required',
  'paid_required',
  'trial_only',
  'copyright_unavailable',
  'credentials_required',
  'video_unavailable',
  'encrypted_audio_unsupported',
]);

const TECHNICAL_FAILURES = new Set([
  'url_unavailable',
  'network_error',
  'request_failed',
  'format_unsupported',
  'http_error',
  'timeout',
  'playback_error',
]);

function resultCategory(result) {
  return String(result?.reason || result?.restriction?.category || '').trim().toLowerCase();
}

function isCustomFirstMode(mode) {
  const value = String(mode || '').toLowerCase();
  return value === 'custom-first' || value === 'custom-only';
}

function shouldAttemptCustomSource({ enabled, mode, officialResult } = {}) {
  if (!enabled) return false;
  // custom-first / custom-only：第三方音源是主取源路径，无论官方是否拿到地址，都必须继续解析；
  // 解析成功后由前端或调用方决定是否覆盖官方结果（custom-only 一定覆盖；custom-first 未命中时回退官方）。
  if (isCustomFirstMode(mode)) return true;
  // official-first：只有官方没拿到 URL 才考虑第三方，权限类失败不再兜底触发。
  if (!officialResult || officialResult.url) return false;
  const category = resultCategory(officialResult);
  if (RIGHTS_RESTRICTIONS.has(category)) return false;
  if (TECHNICAL_FAILURES.has(category)) return true;
  return !category && !!officialResult.error;
}

module.exports = { RIGHTS_RESTRICTIONS, TECHNICAL_FAILURES, resultCategory, shouldAttemptCustomSource, isCustomFirstMode };
