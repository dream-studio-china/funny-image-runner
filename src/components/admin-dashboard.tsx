"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Copy,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LogOut,
  Menu,
  Paintbrush2,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  TicketCheck,
  UsersRound,
  X,
} from "lucide-react";
import type { Preset } from "@/lib/presets";

type Tab = "overview" | "invites" | "users" | "styles" | "comfyui";
type AdminUser = { id: string; createdAt: string; disabledAt: string | null; invitationCount: number; jobCount: number };
type AdminInvitation = { id: string; userId: string; batchId: string; ordinal: number; issueSource: string | null; createdAt: string; expiresAt: string | null; redeemedAt: string | null; revokedAt: string | null };
type UserInvitation = AdminInvitation & { inviteCode: string | null; inviteUrl: string | null; unavailableReason: "revoked" | "expired" | "hash_only" | null };
type AdminPreset = Preset & { enabled: boolean; updatedAt: string };

const tabs: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: "overview", label: "总览", icon: Activity },
  { id: "invites", label: "邀请码", icon: TicketCheck },
  { id: "users", label: "用户管理", icon: UsersRound },
  { id: "styles", label: "风格配置", icon: Paintbrush2 },
  { id: "comfyui", label: "ComfyUI", icon: Server },
];

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function invitationActionError(reason: unknown): string {
  if (!(reason instanceof Error)) return "操作失败，请稍后重试。";
  if (reason.message === "order_conflict") return "此订单引用已绑定其他用户，请检查订单引用或用户标识。";
  if (reason.message === "invitation_revoked") return "此订单对应的邀请码已撤销；如需补发，请使用新的订单引用。";
  if (reason.message === "user_disabled") return "该用户已停用，请先在用户管理中启用后再签发。";
  if (reason.message === "unauthorized") return "管理员会话已失效，请重新登录后台。";
  if (reason.message === "service_unavailable") return "签发服务配置不完整。检查 DATABASE_URL、APP_BASE_URL 和 INVITATION_ENCRYPTION_KEY；修改后重启 Next.js。";
  return "签发失败，请检查订单引用和服务配置后重试。";
}

export default function AdminDashboard() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [token, setToken] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [invitations, setInvitations] = useState<AdminInvitation[]>([]);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [userInvitations, setUserInvitations] = useState<Record<string, UserInvitation[]>>({});
  const [loadingUserInvitations, setLoadingUserInvitations] = useState<string | null>(null);
  const [presets, setPresets] = useState<AdminPreset[]>([]);
  const [search, setSearch] = useState("");
  const [userId, setUserId] = useState("");
  const [customerRef, setCustomerRef] = useState("");
  const [orderRef, setOrderRef] = useState("");
  const [issuedUrl, setIssuedUrl] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reissuingInvitationId, setReissuingInvitationId] = useState<string | null>(null);

  const requestJson = useCallback(async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(url, { ...init, cache: "no-store", headers: { ...(init?.headers ?? {}), ...(init?.body ? { "content-type": "application/json" } : {}) } });
    const payload = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? `request_failed_${response.status}`);
    return payload;
  }, []);

  const loadData = useCallback(async () => {
    const [userData, invitationData, presetData] = await Promise.all([
      requestJson<{ users: AdminUser[] }>(`/api/admin/users?limit=100&search=${encodeURIComponent(search)}`),
      requestJson<{ invitations: AdminInvitation[] }>("/api/admin/invitations?limit=100"),
      requestJson<{ presets: AdminPreset[] }>("/api/admin/presets"),
    ]);
    setUsers(userData.users);
    setInvitations(invitationData.invitations);
    setPresets(presetData.presets);
  }, [requestJson, search]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/session", { cache: "no-store" })
      .then((response) => { if (!cancelled) setAuthenticated(response.ok); })
      .catch(() => { if (!cancelled) setAuthenticated(false); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    const timeout = setTimeout(() => {
      loadData().catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取后台数据");
      });
    }, 0);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [authenticated, loadData]);

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || busy) return;
    setBusy(true);
    setError("");
    try {
      await requestJson("/api/admin/session", { method: "POST", body: JSON.stringify({ token }) });
      setToken("");
      setAuthenticated(true);
      setNotice("管理员会话已开启，有效期 8 小时");
    } catch (reason) {
      setError(reason instanceof Error && reason.message === "invalid_credentials" ? "管理员凭证不正确" : "无法登录，请确认服务端和数据库正常");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/admin/session", { method: "DELETE" }).catch(() => undefined);
    setAuthenticated(false);
    setUsers([]);
    setInvitations([]);
    setPresets([]);
    setExpandedUserId(null);
    setUserInvitations({});
  }

  async function issueInvitation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setIssuedUrl("");
    const reference = orderRef.trim() || `manual-${crypto.randomUUID()}`;
    try {
      const result = await requestJson<{ userId: string; inviteUrl: string; idempotent: boolean }>("/api/admin/invitations/issue", {
        method: "POST",
        body: JSON.stringify({ orderRef: reference, ...(userId.trim() ? { userId: userId.trim() } : {}), ...(customerRef.trim() ? { customerRef: customerRef.trim() } : {}) }),
      });
      setIssuedUrl(result.inviteUrl);
      setOrderRef(reference);
      setNotice(result.idempotent ? "该订单引用已签发，已返回原登录链接" : `已为 ${result.userId} 签发可重复登录的链接`);
      await loadData();
    } catch (reason) {
      setError(invitationActionError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function setUserDisabled(user: AdminUser) {
    const disabled = !user.disabledAt;
    if (!window.confirm(disabled ? `停用用户 ${user.id}？其登录会话会立即撤销。` : `重新启用用户 ${user.id}？`)) return;
    setError("");
    try {
      await requestJson(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify({ disabled }) });
      await loadData();
      setNotice(disabled ? `已停用 ${user.id}` : `已启用 ${user.id}`);
    } catch {
      setError("用户状态更新失败");
    }
  }

  async function toggleUserInvitations(user: AdminUser) {
    if (expandedUserId === user.id) {
      setExpandedUserId(null);
      return;
    }
    setExpandedUserId(user.id);
    if (userInvitations[user.id]) return;
    setLoadingUserInvitations(user.id);
    try {
      const result = await requestJson<{ invitations: UserInvitation[] }>(`/api/admin/users/${encodeURIComponent(user.id)}/invitations`);
      setUserInvitations((current) => ({ ...current, [user.id]: result.invitations }));
    } catch {
      setError("无法读取该用户的邀请码；确认后台加密密钥配置正确");
    } finally {
      setLoadingUserInvitations(null);
    }
  }

  async function revokeInvitation(invitation: AdminInvitation) {
    if (!window.confirm(`撤销用户 ${invitation.userId} 的这条登录链接？撤销后不能用它创建新的登录会话。`)) return;
    try {
      await requestJson(`/api/admin/invitations/${invitation.id}/revoke`, { method: "POST" });
      setUserInvitations((current) => Object.fromEntries(Object.entries(current).map(([id, rows]) => [
        id,
        rows.map((row) => row.id === invitation.id ? { ...row, revokedAt: new Date().toISOString(), inviteCode: null, inviteUrl: null, unavailableReason: "revoked" as const } : row),
      ])));
      await loadData();
      setNotice("邀请码已撤销");
    } catch {
      setError("邀请码已使用或撤销失败");
    }
  }

  async function reissueInvitation(invitation: AdminInvitation) {
    if (busy || reissuingInvitationId) return;
    setBusy(true);
    setReissuingInvitationId(invitation.id);
    setError("");
    setIssuedUrl("");
    const reference = `admin-reissue-${invitation.id}-${crypto.randomUUID()}`;
    try {
      const result = await requestJson<{ userId: string; inviteUrl: string; idempotent: boolean }>("/api/admin/invitations/issue", {
        method: "POST",
        body: JSON.stringify({ userId: invitation.userId, orderRef: reference }),
      });
      setUserId(result.userId);
      setCustomerRef("");
      setOrderRef(reference);
      setIssuedUrl(result.inviteUrl);
      setNotice(`已为 ${result.userId} 签发新登录链接；原链接仍有效，如需停用请单独撤销。`);
      setUserInvitations((current) => { const next = { ...current }; delete next[invitation.userId]; return next; });
      await loadData();
    } catch (reason) {
      setError(invitationActionError(reason));
    } finally {
      setBusy(false);
      setReissuingInvitationId(null);
    }
  }

  async function savePreset(preset: AdminPreset) {
    setError("");
    try {
      await requestJson(`/api/admin/presets/${encodeURIComponent(preset.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ ...preset, moods: preset.moods }),
      });
      await loadData();
      setNotice(`已保存「${preset.name}」风格设置，新任务将使用新版本`);
    } catch {
      setError("风格设置不合法或保存失败，请检查必填项和心情列表");
    }
  }

  function updatePreset(id: string, patch: Partial<AdminPreset>) {
    setPresets((current) => current.map((preset) => preset.id === id ? { ...preset, ...patch } : preset));
  }

  const activeInvitationCount = invitations.filter((invitation) => !invitation.revokedAt && (!invitation.expiresAt || new Date(invitation.expiresAt) > new Date())).length;
  const activeUserCount = users.filter((user) => !user.disabledAt).length;

  if (checking) return <main className="admin-loading"><LoaderCircle className="spin" size={25} />正在检查管理员会话…</main>;

  if (!authenticated) return <main className="admin-login-page">
    <form className="admin-login-card" onSubmit={login}>
      <Link href="/" className="admin-brand"><span>✳</span> 咔嚓造梦局 <small>STUDIO ADMIN</small></Link>
      <div className="admin-login-symbol"><ShieldCheck size={30} /></div>
      <span className="admin-eyebrow">PRIVATE CONTROL ROOM</span>
      <h1>后台管理</h1>
      <p>使用部署环境的管理员 API 凭证开启一个短时安全会话。</p>
      <label htmlFor="admin-token">管理员凭证</label>
      <div className="admin-secret-input"><KeyRound size={17} /><input id="admin-token" type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="输入 ADMIN_API_TOKEN" required /></div>
      {error && <div className="admin-error" role="alert">{error}</div>}
      <button className="admin-primary-button" type="submit" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : <ShieldCheck size={17} />}登录管理后台</button>
      <Link href="/" className="admin-back-link"><ArrowLeft size={15} /> 返回创作页面</Link>
    </form>
  </main>;

  return <div className="admin-shell">
    <aside className={`admin-sidebar ${mobileNavOpen ? "is-open" : ""}`}>
      <Link className="admin-brand" href="/admin"><span>✳</span> 咔嚓造梦局 <small>STUDIO ADMIN</small></Link>
      <div className="admin-side-caption">控制台</div>
      <nav className="admin-nav" aria-label="管理后台导航">
        {tabs.map(({ id, label, icon: Icon }) => <button type="button" key={id} className={tab === id ? "is-active" : ""} onClick={() => { setTab(id); setMobileNavOpen(false); }}><Icon size={18} /><span>{label}</span>{id === "comfyui" && <span className="nav-soon">预留</span>}</button>)}
      </nav>
      <div className="admin-side-bottom"><span className="admin-security-dot" />安全管理员会话<strong>8 小时有效</strong></div>
      <Link href="/" className="admin-site-link"><ArrowLeft size={16} />返回主站</Link>
    </aside>

    <main className="admin-main">
      <header className="admin-topbar"><button type="button" className="admin-mobile-menu" onClick={() => setMobileNavOpen(!mobileNavOpen)} aria-label="切换导航"><Menu size={21} /></button><div><span>管理后台</span><ChevronDown size={14} /><strong>{tabs.find((item) => item.id === tab)?.label}</strong></div><div className="admin-top-actions"><span className="admin-live-pill"><i />管理会话有效</span><button type="button" className="admin-logout" onClick={logout}><LogOut size={16} /><span>退出</span></button></div></header>
      <div className="admin-content">
        <div className="admin-page-heading"><div><span className="admin-eyebrow">DREAM LAB / ADMIN</span><h1>{tabs.find((item) => item.id === tab)?.label}</h1><p>{tab === "overview" ? "管理邀请码、用户和图像预设。生成服务接入后可在此扩展运维工具。" : tab === "invites" ? "为淘宝自动发货或人工邀请签发一次性访问链接。" : tab === "users" ? "查看用户、任务统计，并启用或停用用户访问。" : tab === "styles" ? "编辑用户可见的风格名称、描述、心情选项和补充提示。" : "ComfyUI 连接与工作流控制位于同机 worker，当前作为预留区域。"}</p></div><button type="button" className="admin-refresh" onClick={() => { void loadData(); }}><RefreshCw size={15} />刷新数据</button></div>
        {notice && <div className="admin-notice"><Check size={16} />{notice}<button type="button" onClick={() => setNotice("")} aria-label="关闭提示"><X size={15} /></button></div>}
        {error && <div className="admin-error admin-global-error" role="alert"><CircleHelp size={16} />{error}<button type="button" onClick={() => setError("")} aria-label="关闭错误"><X size={15} /></button></div>}

        {tab === "overview" && <section className="admin-overview">
          <div className="admin-welcome-card"><div><span className="admin-eyebrow">GOOD TO SEE YOU</span><h2>今天想让哪些灵感<br />开始流动？</h2><p>邀请用户、管理可用风格，或检查服务接入准备。</p><button type="button" onClick={() => setTab("invites")}>签发邀请链接 <ArrowRight size={16} /></button></div><div className="admin-welcome-art"><Sparkles size={74} /><span>✳</span></div></div>
          <div className="admin-stats-grid"><article className="admin-stat-card"><span><UsersRound size={17} />用户</span><strong>{users.length}</strong><small>{activeUserCount} 位可访问</small></article><article className="admin-stat-card"><span><TicketCheck size={17} />邀请码</span><strong>{invitations.length}</strong><small>{activeInvitationCount} 张当前可登录</small></article><article className="admin-stat-card"><span><Paintbrush2 size={17} />启用风格</span><strong>{presets.filter((preset) => preset.enabled).length}</strong><small>共 {presets.length} 个配置</small></article><article className="admin-stat-card"><span><Server size={17} />ComfyUI</span><strong className="stat-pending">预留</strong><small>等待 workflow 接入</small></article></div>
          <div className="admin-overview-grid"><article className="admin-panel"><div className="admin-panel-heading"><span><Clock3 size={17} />最近邀请</span><button type="button" onClick={() => setTab("invites")}>查看全部 <ArrowRight size={14} /></button></div>{invitations.slice(0, 5).map((invitation) => <div className="admin-mini-row" key={invitation.id}><span className={`mini-status ${invitation.redeemedAt ? "is-used" : ""}`} /><span><b>{invitation.userId}</b><small>{formatDate(invitation.createdAt)}</small></span><em>{invitation.revokedAt ? "已撤销" : invitation.redeemedAt ? "已登录过 · 仍可用" : "可登录"}</em></div>)}{!invitations.length && <div className="admin-panel-empty">还没有签发记录</div>}</article><article className="admin-panel comfy-summary"><div className="admin-panel-heading"><span><Server size={17} />生成服务</span><span className="pending-chip">尚未接入</span></div><div className="comfy-summary-body"><div className="comfy-icon"><Server size={24} /></div><div><b>ComfyUI / 本地 worker</b><p>后台暂不连接本地服务，避免向公网暴露 ComfyUI。</p></div></div><button type="button" onClick={() => setTab("comfyui")}>查看接入预留 <ArrowRight size={14} /></button></article></div>
        </section>}

        {tab === "invites" && <section className="admin-section-grid"><article className="admin-panel issue-panel"><div className="admin-panel-heading"><span><TicketCheck size={18} />创建邀请链接</span><span className="secure-chip"><ShieldCheck size={13} />可重复登录</span></div><p className="admin-panel-description">邀请码可重复登录，直到过期或撤销。API 自动发码使用订单引用保证幂等；同一个订单重试会返回相同链接。</p><form className="admin-form" onSubmit={issueInvitation}><label>用户标识 <small>选填；留空时根据客户引用派生</small><input value={userId} onChange={(event) => setUserId(event.target.value)} maxLength={64} placeholder="例如 buyer_2026_001" pattern="[A-Za-z0-9_-]{3,64}" /></label><label>客户引用 <small>选填；用于跨订单保持用户标识稳定</small><input value={customerRef} onChange={(event) => setCustomerRef(event.target.value)} maxLength={256} placeholder="例如平台用户 ID（只会存派生值）" /></label><label>订单引用 <small>重试时必须保持一致；为空时自动生成新引用</small><input value={orderRef} onChange={(event) => setOrderRef(event.target.value)} maxLength={256} placeholder="订单号 / 明细号 / 发货序号" /></label><button className="admin-primary-button" type="submit" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}签发登录链接</button></form>{issuedUrl && <div className="issued-link-box"><span>专属邀请链接</span><div><input readOnly value={issuedUrl} aria-label="已签发邀请链接" /><button type="button" onClick={() => { void navigator.clipboard.writeText(issuedUrl); setNotice("邀请链接已复制"); }} aria-label="复制链接"><Copy size={16} /></button><a href={issuedUrl} target="_blank" rel="noreferrer" aria-label="打开邀请链接"><ExternalLink size={16} /></a></div><small>链接包含可重复使用的登录凭证，请仅通过私密渠道交付给对应用户。</small></div>}</article><article className="admin-panel issue-help"><div className="admin-panel-heading"><span><CircleHelp size={18} />淘宝自动发货接入</span></div><ol><li>淘宝发货系统服务端请求 <code>POST /api/admin/invitations/issue</code>。</li><li>发送稳定且每份交付唯一的 <code>orderRef</code>，以及可选的 <code>customerRef</code>/<code>userId</code>。</li><li>将响应中的 <code>inviteUrl</code> 自动发给买家；不要向买家暴露管理员 token。</li><li>先校验淘宝回调签名，再调用本站接口。本站当前尚未实现淘宝回调验签。</li></ol><div className="issue-idempotent-note"><Check size={15} />重复订单请求不会生成第二个登录链接</div></article><article className="admin-panel table-panel"><div className="admin-panel-heading"><span><TicketCheck size={18} />最近签发记录</span><button type="button" onClick={() => { void loadData(); }}><RefreshCw size={14} />更新</button></div><div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>用户</th><th>来源</th><th>创建时间</th><th>过期时间</th><th>状态 / 操作</th></tr></thead><tbody>{invitations.map((invitation) => <tr key={invitation.id}><td><b>{invitation.userId}</b><small>{invitation.batchId}</small></td><td>{invitation.issueSource ?? "人工批次"}</td><td>{formatDate(invitation.createdAt)}</td><td>{formatDate(invitation.expiresAt)}</td><td><span className={`admin-status ${invitation.revokedAt ? "is-used" : invitation.redeemedAt ? "is-ready" : "is-ready"}`}>{invitation.revokedAt ? "已撤销" : invitation.redeemedAt ? "已登录过 · 仍可用" : "可登录"}</span><button className="table-action" type="button" disabled={busy} title="为同一用户签发一条新的登录链接；原邀请仍有效" onClick={() => { void reissueInvitation(invitation); }}>{reissuingInvitationId === invitation.id ? "签发中…" : "重新签发"}</button>{!invitation.revokedAt && <button className="table-action danger-action" type="button" onClick={() => { void revokeInvitation(invitation); }}>撤销</button>}</td></tr>)}</tbody></table>{!invitations.length && <div className="admin-panel-empty">暂无邀请码记录</div>}</div></article></section>}

        {tab === "users" && <section className="admin-panel table-panel"><div className="admin-panel-heading"><span><UsersRound size={18} />用户账户</span><label className="admin-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索用户标识" /></label></div><div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>用户标识</th><th>创建时间</th><th>邀请码</th><th>任务数</th><th>状态</th><th>操作</th></tr></thead><tbody>{users.map((user) => <Fragment key={user.id}><tr><td><b>{user.id}</b></td><td>{formatDate(user.createdAt)}</td><td>{user.invitationCount}<button type="button" className="table-action" onClick={() => { void toggleUserInvitations(user); }}>{expandedUserId === user.id ? "收起" : "查看"}</button></td><td>{user.jobCount}</td><td><span className={`admin-status ${user.disabledAt ? "is-used" : "is-ready"}`}>{user.disabledAt ? "已停用" : "可访问"}</span></td><td><button type="button" className={`table-action ${user.disabledAt ? "" : "danger-action"}`} onClick={() => { void setUserDisabled(user); }}>{user.disabledAt ? "启用" : "停用"}</button></td></tr>{expandedUserId === user.id && <tr key={`${user.id}-invites`}><td colSpan={6}><div className="user-invitation-list">{loadingUserInvitations === user.id ? <div className="admin-panel-empty">正在读取邀请凭证…</div> : (userInvitations[user.id] ?? []).length ? (userInvitations[user.id] ?? []).map((invite) => <div className="user-invitation-item" key={invite.id}><div className="user-invitation-info"><b>{invite.issueSource ?? "人工批次"} · {invite.batchId}</b><span>{invite.revokedAt ? "已撤销" : invite.expiresAt && new Date(invite.expiresAt) <= new Date() ? "已过期" : invite.redeemedAt ? "已登录过 · 仍可用" : "可登录"} · 首次登录 {formatDate(invite.redeemedAt)}</span></div>{invite.inviteCode && invite.inviteUrl ? <div className="user-invitation-secret"><code>{invite.inviteCode}</code><button type="button" onClick={() => { void navigator.clipboard.writeText(invite.inviteCode!); setNotice("邀请码已复制"); }}><Copy size={14} />复制</button><button type="button" onClick={() => { void navigator.clipboard.writeText(invite.inviteUrl!); setNotice("登录链接已复制"); }}><ExternalLink size={14} />复制链接</button></div> : <div className="user-invitation-unavailable">{invite.unavailableReason === "hash_only" ? "此邀请由旧版 CLI 导入，数据库仅保存摘要，无法还原明文；可使用原 seed 重建，或重新签发。" : invite.unavailableReason === "revoked" ? "此邀请已撤销。" : "此邀请已过期。"}</div>}</div>) : <div className="admin-panel-empty">该用户暂无邀请记录</div>}</div></td></tr>}</Fragment>)}</tbody></table>{!users.length && <div className="admin-panel-empty">未找到用户</div>}</div></section>}

        {tab === "styles" && <section className="admin-style-grid">{presets.map((preset) => <article className="admin-panel style-editor" key={preset.id}><div className="style-editor-heading"><div className="style-preview-swatch" style={{ backgroundColor: preset.tint, backgroundImage: `url(${preset.image})` }} /><div><span className="admin-eyebrow">{preset.id} · V{preset.version}</span><h2>{preset.name}</h2><label className="admin-toggle"><input type="checkbox" checked={preset.enabled} onChange={(event) => updatePreset(preset.id, { enabled: event.target.checked })} /><span />{preset.enabled ? "已启用" : "已停用"}</label></div></div><div className="style-fields"><label>风格名称<input value={preset.name} onChange={(event) => updatePreset(preset.id, { name: event.target.value })} maxLength={100} /></label><label>英文副标题<input value={preset.subtitle} onChange={(event) => updatePreset(preset.id, { subtitle: event.target.value })} maxLength={100} /></label><label>简短介绍<textarea value={preset.description} onChange={(event) => updatePreset(preset.id, { description: event.target.value })} maxLength={500} rows={2} /></label><label>提示字段标签<input value={preset.promptLabel} onChange={(event) => updatePreset(preset.id, { promptLabel: event.target.value })} maxLength={100} /></label><label>提示字段占位文案<input value={preset.promptPlaceholder} onChange={(event) => updatePreset(preset.id, { promptPlaceholder: event.target.value })} maxLength={200} /></label><label>心情选项 <small>以逗号分隔，至少一个</small><input value={preset.moods.join("，")} onChange={(event) => updatePreset(preset.id, { moods: event.target.value.split(/[，,]/).map((value) => value.trim()).filter(Boolean) })} /></label><div className="color-fields"><label>底色<input type="color" value={preset.tint} onChange={(event) => updatePreset(preset.id, { tint: event.target.value })} /></label><label>强调色<input type="color" value={preset.accent} onChange={(event) => updatePreset(preset.id, { accent: event.target.value })} /></label></div></div><div className="style-editor-footer"><span>workflow 映射待 ComfyUI 配置后接入</span><button type="button" className="admin-primary-button" onClick={() => { void savePreset(preset); }}><Check size={15} />保存风格</button></div></article>)}</section>}

        {tab === "comfyui" && <section className="admin-comfy-page"><article className="admin-panel comfy-reserved"><div className="comfy-reserved-icon"><Server size={35} /></div><span className="pending-chip">COMFYUI WORKER 未接入</span><h2>本地生成服务，<br />正在等待工作流。</h2><p>ComfyUI 与 worker 在本地同机运行。后台不会直接访问 ComfyUI，也不会将端口暴露到公网。提供 API 格式 workflow JSON 后，再接入 worker 心跳、任务队列和服务健康状态。</p><div className="comfy-checklist"><span><Check size={15} />本地 worker 接口边界已设计</span><span><Clock3 size={15} />等待 API 格式 workflow JSON</span><span><Clock3 size={15} />等待 ComfyUI 节点与模型映射</span></div></article><article className="admin-panel comfy-security"><ShieldCheck size={21} /><b>安全边界</b><p>未来由同机 worker 主动轮询服务端任务，再访问 `127.0.0.1:8188`。请勿将 ComfyUI 服务端口映射到公网。</p></article></section>}
      </div>
    </main>
  </div>;
}
