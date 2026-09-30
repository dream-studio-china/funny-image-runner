"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Search, Settings2, UsersRound, X } from "lucide-react";

type UserRow = {
  id: string;
  createdAt: string;
  disabledAt: string | null;
  totalJobLimit: number | null;
  dailyJobLimit: number | null;
  accountExpiresAt: string | null;
  invitationCount: number;
  jobCount: number;
};
type Limits = { totalJobLimit: number | null; dailyJobLimit: number };
type Draft = { totalJobLimit: string; dailyJobLimit: string; accountExpiresAt: string };

function localDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function displayDate(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" }) : "无限期";
}

export default function AccountLimitsPanel() {
  const [defaults, setDefaults] = useState<Limits>({ totalJobLimit: null, dailyJobLimit: 10 });
  const [totalDefault, setTotalDefault] = useState("");
  const [dailyDefault, setDailyDefault] = useState("10");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [totalUsers, setTotalUsers] = useState(0);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [draft, setDraft] = useState<Draft>({ totalJobLimit: "", dailyJobLimit: "", accountExpiresAt: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const requestJson = useCallback(async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(url, { ...init, cache: "no-store", headers: { ...(init?.headers ?? {}), ...(init?.body ? { "content-type": "application/json" } : {}) } });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? `request_failed_${response.status}`);
    return data;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [settingsResult, usersResult] = await Promise.all([
        requestJson<{ settings: Limits }>("/api/admin/settings"),
        requestJson<{ users: UserRow[]; total: number }>(`/api/admin/users?limit=20&offset=${page * 20}&search=${encodeURIComponent(search)}`),
      ]);
      setDefaults(settingsResult.settings);
      setTotalDefault(settingsResult.settings.totalJobLimit === null ? "" : String(settingsResult.settings.totalJobLimit));
      setDailyDefault(String(settingsResult.settings.dailyJobLimit));
      setUsers(usersResult.users);
      setTotalUsers(usersResult.total);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取账户配额");
    } finally {
      setLoading(false);
    }
  }, [page, requestJson, search]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  async function saveDefaults(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const total = totalDefault.trim() === "" ? null : Number(totalDefault);
    const daily = Number(dailyDefault);
    if ((total !== null && (!Number.isSafeInteger(total) || total < 0)) || !Number.isSafeInteger(daily) || daily < 0) {
      setError("限额须为 0 或更大的整数；总任务限额留空表示不限。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await requestJson<{ settings: Limits }>("/api/admin/settings", { method: "PATCH", body: JSON.stringify({ totalJobLimit: total, dailyJobLimit: daily }) });
      setDefaults(result.settings);
      setNotice("全局默认配额已保存。用户的细分设置优先于全局默认值。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存全局配额失败");
    } finally {
      setSaving(false);
    }
  }

  function openEditor(user: UserRow) {
    setEditing(user);
    setDraft({
      totalJobLimit: user.totalJobLimit === null ? "" : String(user.totalJobLimit),
      dailyJobLimit: user.dailyJobLimit === null ? "" : String(user.dailyJobLimit),
      accountExpiresAt: localDateTime(user.accountExpiresAt),
    });
    setError("");
  }

  async function saveUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const total = draft.totalJobLimit.trim() === "" ? null : Number(draft.totalJobLimit);
    const daily = draft.dailyJobLimit.trim() === "" ? null : Number(draft.dailyJobLimit);
    if ((total !== null && (!Number.isSafeInteger(total) || total < 0)) || (daily !== null && (!Number.isSafeInteger(daily) || daily < 0))) {
      setError("限额须为 0 或更大的整数；留空表示沿用全局设置。");
      return;
    }
    const accountExpiresAt = draft.accountExpiresAt ? new Date(draft.accountExpiresAt).toISOString() : null;
    setSaving(true);
    setError("");
    try {
      await requestJson(`/api/admin/users/${encodeURIComponent(editing.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ totalJobLimit: total, dailyJobLimit: daily, accountExpiresAt }),
      });
      setNotice(`已更新 ${editing.id} 的配额和账户有效期`);
      setEditing(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存用户配额失败");
    } finally {
      setSaving(false);
    }
  }

  return <section className="account-limits-page">
    <article className="admin-panel">
      <div className="admin-panel-heading"><span><Settings2 size={18} />全局默认配额</span></div>
      <p className="admin-panel-description">新用户和未设置个人覆盖值的用户使用这里的默认值。用户细分设置优先；修改默认值不会覆盖用户的个人配置。</p>
      <form className="account-limits-form" onSubmit={saveDefaults}>
        <label>总任务上限 <small>统计账户创建的全部任务；留空表示不设上限</small><input type="number" min="0" step="1" value={totalDefault} onChange={(event) => setTotalDefault(event.target.value)} placeholder="不限" /></label>
        <label>每日任务上限 <small>按 UTC 自然日统计创建的任务</small><input type="number" min="0" step="1" required value={dailyDefault} onChange={(event) => setDailyDefault(event.target.value)} /></label>
        <button type="submit" className="admin-primary-button" disabled={saving}>{saving ? "保存中…" : <><Check size={15} />保存全局默认</>}</button>
      </form>
      {notice && <div className="admin-notice"><Check size={15} />{notice}<button type="button" onClick={() => setNotice("")} aria-label="关闭提示"><X size={14} /></button></div>}
      {error && <div className="admin-error" role="alert">{error}<button type="button" onClick={() => setError("")} aria-label="关闭错误"><X size={14} /></button></div>}
      <small className="account-default-summary">当前默认：总计 {defaults.totalJobLimit === null ? "不限" : defaults.totalJobLimit} 次 · 每日 {defaults.dailyJobLimit} 次</small>
    </article>

    <article className="admin-panel table-panel">
      <div className="admin-panel-heading"><span><UsersRound size={18} />用户细分设置</span><label className="admin-search"><Search size={15} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="搜索用户标识" /></label></div>
      <p className="admin-panel-description">个人限额留空时沿用全局默认；账户失效时间留空表示无限期。任务限额 0 会阻止该账户创建任务。</p>
      <div className="admin-table-scroll"><table className="admin-table account-limits-table"><thead><tr><th>用户</th><th>任务数</th><th>总任务限额</th><th>每日限额</th><th>账户失效时间</th><th>操作</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td><b>{user.id}</b><small>{user.disabledAt ? "已停用" : "可访问"} · 创建于 {new Date(user.createdAt).toLocaleDateString("zh-CN")}</small></td><td>{user.jobCount}</td><td>{user.totalJobLimit === null ? `默认 (${defaults.totalJobLimit === null ? "不限" : defaults.totalJobLimit})` : user.totalJobLimit}</td><td>{user.dailyJobLimit === null ? `默认 (${defaults.dailyJobLimit})` : user.dailyJobLimit}</td><td>{displayDate(user.accountExpiresAt)}</td><td><button type="button" className="table-action" onClick={() => openEditor(user)}>配额 / 有效期</button></td></tr>)}</tbody></table>{!users.length && <div className="admin-panel-empty">{loading ? "正在加载用户…" : "没有匹配的用户"}</div>}</div>
      <div className="admin-pagination"><span>共 {totalUsers} 位用户 · 第 {page + 1} / {Math.max(1, Math.ceil(totalUsers / 20))} 页</span><div><button type="button" disabled={!page || loading} onClick={() => setPage((value) => Math.max(0, value - 1))}>上一页</button><button type="button" disabled={(page + 1) * 20 >= totalUsers || loading} onClick={() => setPage((value) => value + 1)}>下一页</button></div></div>
    </article>

    {editing && <div className="admin-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditing(null); }}><section className="admin-user-dialog account-limit-dialog" role="dialog" aria-modal="true" aria-labelledby="account-limit-title"><header><div><span className="admin-eyebrow">ACCOUNT / {editing.id}</span><h2 id="account-limit-title">配额和有效期</h2></div><button type="button" onClick={() => setEditing(null)} aria-label="关闭弹窗"><X size={20} /></button></header><form className="account-limits-form" onSubmit={saveUser}><label>总任务上限 <small>留空沿用全局默认：{defaults.totalJobLimit === null ? "不限" : `${defaults.totalJobLimit} 次`}</small><input type="number" min="0" step="1" value={draft.totalJobLimit} onChange={(event) => setDraft((value) => ({ ...value, totalJobLimit: event.target.value }))} placeholder="沿用全局默认" /></label><label>每日任务上限 <small>留空沿用全局默认：{defaults.dailyJobLimit} 次</small><input type="number" min="0" step="1" value={draft.dailyJobLimit} onChange={(event) => setDraft((value) => ({ ...value, dailyJobLimit: event.target.value }))} placeholder="沿用全局默认" /></label><label>账户失效时间 <small>留空表示无限期；过期后当前会话也立即失效</small><input type="datetime-local" value={draft.accountExpiresAt} onChange={(event) => setDraft((value) => ({ ...value, accountExpiresAt: event.target.value }))} /></label><div className="catalog-form-actions"><button type="button" className="admin-secondary-button" onClick={() => setEditing(null)}>取消</button><button type="submit" className="admin-primary-button" disabled={saving}>{saving ? "保存中…" : "保存用户设置"}</button></div>{error && <div className="admin-error" role="alert">{error}</div>}</form></section></div>}
  </section>;
}
