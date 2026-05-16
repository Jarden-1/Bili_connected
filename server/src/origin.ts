// 共享的 Origin 解析/校验。
//
// 叶子模块：除标准库外无任何业务依赖，供「配置期 ALLOWED_ORIGINS 白名单
// 校验」与「运行期 Firefox 扩展 Origin 放行」复用同一份裸 origin 规则，
// 避免与 app/security/config 形成循环导入。
//
// 「裸 origin」定义：`scheme://host`，无路径/查询/片段/userinfo/尾斜杠/
// 混合大小写 host —— 与 HTTP `Origin` 头被精确匹配的形态一致。

export type BareOriginCheck =
  | { ok: true; canonical: string; scheme: string }
  | { ok: false; reason: "empty" | "wildcard" | "invalid_url" | "no_host" }
  | { ok: false; reason: "unsupported_scheme"; scheme: string }
  | { ok: false; reason: "not_bare"; canonical: string };

export function checkBareOrigin(
  origin: unknown,
  allowedSchemes: ReadonlySet<string>,
): BareOriginCheck {
  if (typeof origin !== "string" || origin.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (origin.includes("*")) {
    return { ok: false, reason: "wildcard" };
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (!allowedSchemes.has(parsed.protocol)) {
    return { ok: false, reason: "unsupported_scheme", scheme: parsed.protocol };
  }
  if (parsed.host.length === 0) {
    return { ok: false, reason: "no_host" };
  }

  const canonical = `${parsed.protocol}//${parsed.host}`;
  if (origin !== canonical) {
    return { ok: false, reason: "not_bare", canonical };
  }
  return { ok: true, canonical, scheme: parsed.protocol };
}

const MOZ_EXTENSION_ONLY: ReadonlySet<string> = new Set(["moz-extension:"]);

// 运行期判定：origin 是否为格式正确的裸 `moz-extension://<uuid>`。
// 与配置期校验完全相同的严格度，挡掉带路径/userinfo/大小写的伪造串。
export function isBareMozExtensionOrigin(origin: string | null): boolean {
  if (origin === null) {
    return false;
  }
  return checkBareOrigin(origin, MOZ_EXTENSION_ONLY).ok;
}
