/** Redact capabilities before persistence and again before diagnostics leave the app. */
export function redactLogSecrets(text: string): string {
  return text
    .replace(/([?&#])([^=&#\s"'<>)]{1,80})=([^&#\s"'<>)]*)/g, (match, separator: string, name: string) => {
      let key: string;
      try { key = decodeURIComponent(name).replace(/[-_]/g, "").toLowerCase(); } catch { return match; }
      return /^(?:token|ticket|accesstoken|refreshtoken|apikey|key|signature|sig|authorization|secret|clientsecret|password|code)$/.test(key)
        ? `${separator}${name}=***` : match;
    })
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1***@")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1***")
    .replace(/(127\.0\.0\.1:\d+\/)([A-Za-z0-9_-]{8,})(?=\/|\s|$)/g,
      (_match, origin: string, segment: string) => `${origin}${segment === '__cryoclaw__' ? segment : '***'}`);
}
