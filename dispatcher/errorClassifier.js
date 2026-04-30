function classifyError(errorText = '') {
  const t = String(errorText || '').toLowerCase();

  if (
    t.includes('etimedout') ||
    t.includes('timeout') ||
    t.includes('econnreset') ||
    t.includes('connection reset') ||
    t.includes('network error') ||
    t.includes('socket hang up')
  ) {
    return { type: 'TRANSIENT', retryable: true };
  }

  if (
    t.includes('syntaxerror') ||
    t.includes('typeerror') ||
    t.includes('referenceerror') ||
    t.includes('npm run build') ||
    t.includes('build failed') ||
    t.includes('test failed') ||
    t.includes('lint failed')
  ) {
    return { type: 'CODE', retryable: false };
  }

  if (
    t.includes('missing env') ||
    t.includes('missing') && t.includes('env') ||
    t.includes('invalid app_env') ||
    t.includes('config error')
  ) {
    return { type: 'ENV', retryable: false };
  }

  return { type: 'UNKNOWN', retryable: true };
}

module.exports = { classifyError };
