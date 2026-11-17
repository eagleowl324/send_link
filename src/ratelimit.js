'use strict';

const MAX_KEYS = 20000;

// 키(보통 IP)별 고정 구간 카운터. 구간 안에서 max번을 넘기면 blocked()가 true가 됩니다.
class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.buckets = new Map();
  }

  hit(key, now = Date.now()) {
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      // 메모리 보호: 키가 비정상적으로 많아지면 만료된 것부터, 그래도 많으면 가장 오래된 것부터 버립니다.
      // (전부 지우면 한창 제한 중이던 키까지 풀려 버리므로 일부만 버립니다)
      if (this.buckets.size >= MAX_KEYS) this.sweep(now);
      if (this.buckets.size >= MAX_KEYS) {
        let drop = Math.ceil(MAX_KEYS / 10);
        for (const old of this.buckets.keys()) {
          this.buckets.delete(old);
          drop -= 1;
          if (drop <= 0) break;
        }
      }
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.delete(key); // 다시 넣어 "최근에 쓴 키"가 되게 합니다
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count;
  }

  blocked(key, now = Date.now()) {
    const bucket = this.buckets.get(key);
    return Boolean(bucket) && bucket.resetAt > now && bucket.count >= this.max;
  }

  retryAfter(key, now = Date.now()) {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) return 0;
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  }

  sweep(now = Date.now()) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

module.exports = { RateLimiter };
