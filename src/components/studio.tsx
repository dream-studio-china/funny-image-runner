"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  ArrowDown,
  ArrowRight,
  Check,
  ChevronDown,
  Download,
  Heart,
  ImagePlus,
  Images,
  Menu,
  Plus,
  RotateCcw,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { presets, type Preset } from "@/lib/presets";

type DemoJob = {
  id: string;
  presetId: string;
  mood: string;
  note: string;
  createdAt: string;
};

type Stage = "idle" | "queued" | "creating" | "done";

const HISTORY_KEY = "dream-studio-demo-history-v1";
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_SIZE = 20 * 1024 * 1024;

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function SectionKicker({ number, children }: { number: string; children: React.ReactNode }) {
  return (
    <div className="section-kicker">
      <span className="kicker-number">{number}</span>
      <span>{children}</span>
      <span className="kicker-line" />
    </div>
  );
}

function PresetCard({ preset, selected, disabled, onSelect }: { preset: Preset; selected: boolean; disabled: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={`preset-card group ${selected ? "is-selected" : ""}`}
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={`选择${preset.name}预设`}
    >
      <div className="preset-art" style={{ backgroundColor: preset.tint }}>
        <Image src={preset.image} alt={`${preset.name}风格示例插画`} fill loading={preset.id === "cloud-nine" ? "eager" : "lazy"} sizes="(max-width: 640px) 46vw, (max-width: 1024px) 24vw, 220px" className="object-cover transition-transform duration-700 group-hover:scale-105" />
        <span className="preset-tag">{preset.tag}</span>
        <span className="preset-tick">{selected ? <Check size={15} strokeWidth={3} /> : <Plus size={16} strokeWidth={2} />}</span>
      </div>
      <div className="preset-meta">
        <div><span className="preset-english">{preset.subtitle}</span><strong>{preset.name}</strong></div>
        <ArrowRight size={19} className="preset-arrow" aria-hidden="true" />
      </div>
    </button>
  );
}

export default function Studio() {
  const [selectedId, setSelectedId] = useState(presets[0].id);
  const [mood, setMood] = useState(presets[0].moods[0]);
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [history, setHistory] = useState<DemoJob[]>([]);
  const [activeJob, setActiveJob] = useState<DemoJob | null>(null);
  const [toast, setToast] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [isRedeeming, setIsRedeeming] = useState(false);
  const [authenticatedUser, setAuthenticatedUser] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const accessTriggerRef = useRef<HTMLButtonElement>(null);
  const accessCloseRef = useRef<HTMLButtonElement>(null);
  const timeoutRefs = useRef<ReturnType<typeof setTimeout>[]>([]);
  const previewRef = useRef<string | null>(null);
  const selected = presets.find((preset) => preset.id === selectedId) ?? presets[0];

  useEffect(() => {
    const loadHistory = setTimeout(() => {
      try {
        const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as unknown;
        if (Array.isArray(stored)) {
          setHistory(stored.filter((item): item is DemoJob =>
            typeof item === "object" && item !== null &&
            typeof item.id === "string" && typeof item.presetId === "string" &&
            typeof item.createdAt === "string" &&
            presets.some((preset) => preset.id === item.presetId)
          ).slice(0, 12));
        }
      } catch {
        localStorage.removeItem(HISTORY_KEY);
      }
    }, 0);
    return () => {
      clearTimeout(loadHistory);
      timeoutRefs.current.forEach(clearTimeout);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/me", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ userId: string }> : null)
      .then((result) => { if (result?.userId) setAuthenticatedUser(result.userId); })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => {
      const currentUrl = new URL(window.location.href);
      const queryCode = currentUrl.searchParams.get("invite");
      const fragment = new URLSearchParams(currentUrl.hash.replace(/^#/, ""));
      const fragmentCode = fragment.get("invite");
      const code = queryCode ?? fragmentCode;
      if (code === null) return;

      currentUrl.searchParams.delete("invite");
      fragment.delete("invite");
      currentUrl.hash = fragment.size ? fragment.toString() : "";
      window.history.replaceState(window.history.state, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);

      const normalizedCode = code.trim();
      if (normalizedCode.length < 12 || normalizedCode.length > 64) {
        setInviteError("邀请链接中的邀请码格式不正确。");
      } else {
        setInviteCode(normalizedCode);
      }
      setShowAccess(true);
    }, 0);
    return () => clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!showAccess) return;
    const trigger = accessTriggerRef.current;
    accessCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowAccess(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [showAccess]);

  const acceptFile = useCallback((candidate?: File) => {
    if (!candidate) return;
    if (!ACCEPTED_TYPES.includes(candidate.type)) {
      setToast("请上传 JPG、PNG 或 WebP 格式的图片");
      return;
    }
    if (candidate.size > MAX_SIZE) {
      setToast("图片不能超过 20 MB，换一张试试吧");
      return;
    }
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    const url = URL.createObjectURL(candidate);
    previewRef.current = url;
    setPreviewUrl(url);
    setFile(candidate);
    setStage("idle");
    setActiveJob(null);
    setToast("图片已准备好，挑选喜欢的风格吧");
  }, []);

  function removeFile() {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setFile(null);
    setPreviewUrl(null);
    if (inputRef.current) inputRef.current.value = "";
    setStage("idle");
  }

  function selectPreset(preset: Preset) {
    setSelectedId(preset.id);
    setMood(preset.moods[0]);
    setNote("");
    setStage("idle");
    setShowDetails(true);
  }

  function startDemo() {
    if (!file) {
      setToast("先放一张照片进来，灵感才有地方着陆 ✦");
      scrollToSection("upload");
      return;
    }
    if (stage === "queued" || stage === "creating") return;
    timeoutRefs.current.forEach(clearTimeout);
    const job: DemoJob = {
      id: crypto.randomUUID(),
      presetId: selected.id,
      mood,
      note: note.trim(),
      createdAt: new Date().toISOString(),
    };
    setActiveJob(job);
    setStage("queued");
    scrollToSection("demo-status");
    timeoutRefs.current = [
      setTimeout(() => setStage("creating"), 950),
      setTimeout(() => {
        setStage("done");
        setHistory((current) => {
          const updated = [job, ...current].slice(0, 12);
          try { localStorage.setItem(HISTORY_KEY, JSON.stringify(updated)); } catch { /* browser storage may be disabled */ }
          return updated;
        });
      }, 3000),
    ];
  }

  function openJob(job: DemoJob) {
    setActiveJob(job);
    setStage("done");
    scrollToSection("demo-status");
  }

  function resetDemo() {
    timeoutRefs.current.forEach(clearTimeout);
    setActiveJob(null);
    setStage("idle");
    setNote("");
    setMood(selected.moods[0]);
    removeFile();
    scrollToSection("upload");
  }

  async function redeemCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inviteCode.trim() || isRedeeming) return;
    setIsRedeeming(true);
    setInviteError("");
    try {
      const response = await fetch("/api/auth/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: inviteCode }),
      });
      const result = await response.json() as { userId?: string; error?: string };
      if (!response.ok || !result.userId) {
        setInviteError(result.error === "service_unavailable" ? "服务暂时不可用，请稍后再试。" : "邀请码无效、已使用或已过期，请检查后重试。");
        return;
      }
      setAuthenticatedUser(result.userId);
      setInviteCode("");
      setShowAccess(false);
      setToast(`欢迎回来，${result.userId}！`);
    } catch {
      setInviteError("暂时无法连接服务，请稍后重试。");
    } finally {
      setIsRedeeming(false);
    }
  }

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      setAuthenticatedUser(null);
      setToast("已安全退出");
    } catch {
      setToast("退出请求未完成，请检查网络");
    }
  }

  const isRunning = stage === "queued" || stage === "creating";
  const resultPreset = presets.find((preset) => preset.id === activeJob?.presetId) ?? selected;

  return (
    <div className="site-shell">
      <div className="announcement"><Sparkles size={13} fill="currentColor" aria-hidden="true" /><span>一个把日常照片变得不太日常的小地方</span><Sparkles size={13} fill="currentColor" aria-hidden="true" /></div>

      <header className="site-header">
        <div className="container header-inner">
          <button type="button" className="brand" onClick={() => scrollToSection("top")} aria-label="咔嚓造梦局，回到顶部">
            <span className="brand-mark"><span>✳</span></span>
            <span className="brand-name">咔嚓<span>造梦局</span><small>THE LITTLE DREAM LAB</small></span>
          </button>
          <nav className="desktop-nav" aria-label="主导航">
            <button onClick={() => scrollToSection("studio")}>开始创作</button>
            <button onClick={() => scrollToSection("inspiration")}>灵感画廊</button>
            <button onClick={() => scrollToSection("my-works")}>我的作品</button>
          </nav>
          <div className="header-actions">
            {authenticatedUser ? <button type="button" className="demo-pill signed-in-pill" onClick={logout} aria-label={`已登录 ${authenticatedUser}，点击退出`}><span className="pulse-dot" />{authenticatedUser}<span className="logout-label">· 退出</span></button> : <button ref={accessTriggerRef} type="button" className="demo-pill" onClick={() => setShowAccess(true)} aria-label="查看邀请码入口"><span className="pulse-dot" />DEMO MODE</button>}
            <button type="button" className="header-create" onClick={() => scrollToSection("studio")}>去创作 <ArrowRight size={15} /></button>
            <button type="button" className="mobile-menu-toggle" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-label={mobileMenuOpen ? "关闭菜单" : "打开菜单"} aria-expanded={mobileMenuOpen}>
              {mobileMenuOpen ? <X size={23} /> : <Menu size={23} />}
            </button>
          </div>
        </div>
        {mobileMenuOpen && <nav className="mobile-menu" aria-label="移动端导航">
          {[{ id: "studio", label: "开始创作" }, { id: "inspiration", label: "灵感画廊" }, { id: "my-works", label: "我的作品" }].map((item) => (
            <button key={item.id} onClick={() => { setMobileMenuOpen(false); scrollToSection(item.id); }}>{item.label}<ArrowRight size={18} /></button>
          ))}
        </nav>}
      </header>

      <main id="top">
        <section className="hero container" aria-labelledby="hero-title">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-star">✳</span> YOUR PHOTO, REIMAGINED <span className="eyebrow-line" /></div>
            <h1 id="hero-title">普通的一天，<br />也值得<span className="hero-highlight">大开脑洞<svg viewBox="0 0 480 26" preserveAspectRatio="none" aria-hidden="true"><path d="M3 21C89 3 180 7 238 13c74 9 151-7 239-10" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/></svg></span><span className="hero-dot">。</span></h1>
            <p>一张照片，一点想象力。挑个喜欢的风格，让你的日常瞬间，变成一件独一无二的小作品。</p>
            <button type="button" className="primary-button hero-button" onClick={() => scrollToSection("studio")}>开始造点梦 <ArrowRight size={18} strokeWidth={2.5} /></button>
            <div className="hero-footnote"><span className="mini-avatars"><i>✿</i><i>✦</i><i>☺</i></span><span>上传照片 · 选择风格 · 收获惊喜</span></div>
          </div>
          <div className="hero-visual" aria-label="云端漫游风格示例画面">
            <div className="hero-visual-back" />
            <div className="hero-image-frame"><Image src="/art/cloud-nine.svg" alt="紫色日落下的人像幻想插画" fill priority loading="eager" sizes="(max-width: 768px) 80vw, 410px" className="object-cover" /></div>
            <div className="floating-note note-top"><Sparkles size={16} fill="currentColor" /><span>想象力<br />正在发芽</span></div>
            <div className="floating-note note-bottom"><span className="note-asterisk">✳</span><span>想象力<br />无限供应</span></div>
            <span className="hero-scribble" aria-hidden="true">✦</span>
            <span className="hero-orbit" aria-hidden="true">↝</span>
            <div className="hero-caption">NO. 001 <span>·</span> CLOUD NINE</div>
          </div>
          <button className="scroll-hint" type="button" onClick={() => scrollToSection("studio")}>向下探索 <ArrowDown size={15} /></button>
        </section>

        <div className="marquee" aria-hidden="true"><div className="marquee-track">MAKE SOMETHING WONDERFUL <span>✳</span> 给生活一点想象力 <span>✳</span> MAKE SOMETHING WONDERFUL <span>✳</span> 给生活一点想象力 <span>✳</span></div></div>

        <section className="studio-section" id="studio" aria-labelledby="studio-title">
          <div className="container">
            <div className="section-heading studio-heading"><div><SectionKicker number="01 / 03">THE CREATIVE STUDIO</SectionKicker><h2 id="studio-title">你的灵感，<em>从这里开始。</em></h2><p>三个小步骤，把脑海里的画面变成眼前的惊喜。</p></div><div className="section-side-art" aria-hidden="true">✳<span>LET&apos;S MAKE<br />SOMETHING!</span></div></div>

            <div className="step-block" id="upload">
              <div className="step-header"><div className="step-number">01</div><div><h3>先放一张照片</h3><p>有故事的画面，从你手里的这一张开始。</p></div><span className="step-side-label">START HERE ↗</span></div>
              <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => acceptFile(event.target.files?.[0])} aria-label="上传照片" />
              <div
                className={`upload-zone ${isDragging ? "is-dragging" : ""} ${previewUrl ? "has-image" : ""}`}
                onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
                onDragLeave={(event) => { event.preventDefault(); setIsDragging(false); }}
                onDrop={(event) => { event.preventDefault(); setIsDragging(false); acceptFile(event.dataTransfer.files[0]); }}
              >
                {previewUrl ? <div className="upload-preview"><div className="upload-image" role="img" aria-label="已上传照片预览" style={{ backgroundImage: `url("${previewUrl}")` }} /><div className="upload-preview-info"><span className="upload-ready"><Check size={14} /> 照片已就位</span><strong title={file?.name}>{file?.name}</strong><span>{file && (file.size / 1024 / 1024).toFixed(2)} MB · 仅在当前浏览器预览</span><div className="upload-preview-actions"><button type="button" onClick={() => inputRef.current?.click()}><RotateCcw size={16} /> 换一张</button><button type="button" onClick={removeFile}><X size={16} /> 移除</button></div></div></div> : <button type="button" className="upload-empty" onClick={() => inputRef.current?.click()}><span className="upload-icon"><ImagePlus size={28} strokeWidth={1.7} /></span><strong>点击上传你的照片 <span>↗</span></strong><span className="upload-subline">或把图片拖到这里，开始一段奇妙旅程</span><span className="upload-formats">JPG、PNG、WEBP <span>·</span> 最大 20 MB</span></button>}
                <span className="upload-corner corner-tl" /><span className="upload-corner corner-br" />
              </div>
            </div>

            <div className="step-block" id="choose-preset">
              <div className="step-header"><div className="step-number">02</div><div><h3>挑一个心动的风格</h3><p>每一种想象，都有不一样的打开方式。</p></div><span className="step-side-label">PICK YOUR MAGIC ↗</span></div>
              <div className="preset-grid">{presets.map((preset) => <PresetCard key={preset.id} preset={preset} disabled={isRunning} selected={selected.id === preset.id} onSelect={() => selectPreset(preset)} />)}</div>
              <div className="selected-preset-note"><Sparkles size={16} /><span><b>{selected.name}</b> · {selected.description}</span></div>
            </div>

            <div className="step-block last-step" id="add-details">
              <div className="step-header"><div className="step-number">03</div><div><h3>再加一点你的想法</h3><p>小小的细节，会让作品更像你。</p></div><span className="step-side-label">THE FINAL TOUCH ↗</span></div>
              <div className="details-card">
                <button type="button" className="details-mobile-toggle" onClick={() => setShowDetails(!showDetails)} aria-expanded={showDetails}>个性化设置 <ChevronDown size={18} className={showDetails ? "rotate-180" : ""} /></button>
                {showDetails && <div className="details-content"><div className="field-group"><label className="field-label">想要什么样的感觉？ <span>选择一种心情</span></label><div className="mood-options">{selected.moods.map((option) => <button key={option} type="button" className={mood === option ? "is-active" : ""} onClick={() => setMood(option)} aria-pressed={mood === option}>{option === "梦幻" || option === "俏皮" || option === "元气" || option === "诗意" ? "✦ " : "✳ "}{option}</button>)}</div></div><div className="field-group"><label htmlFor="extra-note" className="field-label">{selected.promptLabel} <span>选填</span></label><div className="textarea-wrap"><textarea id="extra-note" maxLength={120} placeholder={selected.promptPlaceholder} value={note} onChange={(event) => setNote(event.target.value)} rows={3} /><span>{note.length} / 120</span></div></div></div>}
              </div>
              <div className="create-row"><div className="create-hint"><span>✦</span> 一个新世界，马上打开。<small>当前是界面演示，不会实际上传或生成</small></div><button type="button" className="primary-button create-button" onClick={startDemo} disabled={isRunning}>{isRunning ? "演示进行中…" : "开启奇妙变身"}<WandSparkles size={19} /></button></div>
            </div>

            {stage !== "idle" && activeJob && <div className="status-section" id="demo-status" aria-live="polite">
              {stage !== "done" ? <div className="progress-card"><div className="progress-orb"><Sparkles size={34} /></div><div className="progress-content"><span className="progress-kicker">A LITTLE MAGIC IS HAPPENING</span><h3>{stage === "queued" ? "灵感已收到，准备出发…" : "正在把想象力装进画面…"}</h3><p>正在演示「{resultPreset.name}」的创作流程，请稍等片刻。</p><div className="progress-track"><span className={stage === "creating" ? "is-creating" : ""} /></div><span className="progress-disclaimer">演示进度 · 未连接图像生成服务</span></div></div> : <div className="result-card"><div className="result-art"><Image src={resultPreset.image} alt={`${resultPreset.name}预制风格样图`} fill sizes="(max-width: 768px) 90vw, 340px" className="object-cover" /><span className="result-sample-badge">风格示例样图</span></div><div className="result-copy"><span className="progress-kicker">A LITTLE PREVIEW FOR YOU ✦</span><h3>灵感的样子，<br /><em>先睹为快。</em></h3><p>这是「{resultPreset.name}」的预制风格示例，<strong>不是根据你上传的照片生成</strong>。真实生成功能将在服务端接入后开放。</p><div className="result-stats"><span>风格 <b>{resultPreset.name}</b></span><span>氛围 <b>{activeJob.mood}</b></span></div><div className="result-actions"><a href={resultPreset.image} download={`${resultPreset.id}-sample.svg`} className="secondary-button"><Download size={17} /> 保存示例样图</a><button type="button" className="text-button" onClick={resetDemo}>再玩一次 <ArrowRight size={17} /></button></div></div></div>}
            </div>}
          </div>
        </section>

        <section className="inspiration-section" id="inspiration" aria-labelledby="inspiration-title"><div className="container"><div className="section-heading"><div><SectionKicker number="A LITTLE INSPIRATION">FOR THE CURIOUS ONES</SectionKicker><h2 id="inspiration-title">好玩的世界，<em>不止一种。</em></h2><p>先看看这些风格的样子，再挑你想走进去的那一个。</p></div><span className="inspiration-sun" aria-hidden="true">☼</span></div><div className="inspiration-grid">{presets.map((preset, index) => <button type="button" className="inspiration-item group" key={preset.id} onClick={() => { selectPreset(preset); scrollToSection("choose-preset"); }}><div className="inspiration-image"><Image src={preset.image} alt={`${preset.name}预制风格示例`} fill sizes="(max-width: 640px) 70vw, 280px" className="object-cover transition-transform duration-700 group-hover:scale-105" /><span>0{index + 1}</span></div><div className="inspiration-caption"><span><strong>{preset.name}</strong><small>{preset.subtitle}</small></span><span className="inspiration-arrow"><ArrowRight size={18} /></span></div></button>)}</div><p className="gallery-disclaimer">以上均为预制风格示例插画，不代表实际生成结果。</p></div></section>

        <section className="works-section container" id="my-works" aria-labelledby="works-title"><div className="section-heading"><div><SectionKicker number="YOUR LITTLE COLLECTION">MADE WITH IMAGINATION</SectionKicker><h2 id="works-title">我的<em>灵感小册。</em></h2><p>每一次尝试，都值得留个纪念。</p></div><span className="works-count">{history.length.toString().padStart(2, "0")} 个演示记录</span></div>{history.length ? <><div className="works-grid">{history.map((job) => { const preset = presets.find((item) => item.id === job.presetId) ?? presets[0]; return <button type="button" className="work-card group" key={job.id} onClick={() => openJob(job)}><div className="work-art"><Image src={preset.image} alt={`${preset.name}示例样图`} fill sizes="(max-width: 640px) 45vw, 240px" className="object-cover transition-transform duration-700 group-hover:scale-105" /><span>演示样图</span></div><div className="work-meta"><strong>{preset.name}</strong><span>{new Date(job.createdAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })} <ArrowRight size={15} /></span></div></button>; })}</div><button type="button" className="clear-history" onClick={() => { setHistory([]); try { localStorage.removeItem(HISTORY_KEY); } catch { /* browser storage may be disabled */ } setToast("演示记录已清空"); }}>清空演示记录</button></> : <div className="empty-works"><div className="empty-works-icon"><Images size={35} strokeWidth={1.4} /><span>✦</span></div><h3>这里还是一张白纸</h3><p>创造你的第一个演示作品，<br />让这本灵感小册热闹起来。</p><button type="button" className="secondary-button" onClick={() => scrollToSection("studio")}>去试试看 <ArrowRight size={17} /></button></div>}</section>
      </main>

      <footer className="site-footer"><div className="container footer-inner"><div><div className="footer-logo">✳ 咔嚓造梦局</div><p>让每一张平凡的照片，都有做梦的权利。</p></div><div className="footer-right"><span>MADE FOR THE DAYDREAMERS ✦</span><small>当前为交互演示 · 图像生成服务尚未接入</small></div></div></footer>

      <nav className="mobile-bottom-nav" aria-label="快捷导航"><button type="button" onClick={() => scrollToSection("top")}><Sparkles size={21} /><span>发现</span></button><button type="button" className="mobile-nav-create" onClick={() => scrollToSection("studio")}><Plus size={26} strokeWidth={2.4} /><span>创作</span></button><button type="button" onClick={() => scrollToSection("my-works")}><Heart size={21} /><span>作品</span></button></nav>
      {showAccess && <div className="access-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowAccess(false); }}><div className="access-dialog" role="dialog" aria-modal="true" aria-labelledby="access-title"><button ref={accessCloseRef} type="button" className="access-close" onClick={() => setShowAccess(false)} aria-label="关闭邀请码窗口"><X size={19} /></button><div className="access-symbol">✳</div><span className="progress-kicker">A LITTLE INVITATION</span><h2 id="access-title">欢迎来到<br /><em>造梦局。</em></h2><p>输入管理员发给你的专属邀请码，开启你的创作空间。</p><form onSubmit={redeemCode}><label className="invite-code-label" htmlFor="invite-code">专属邀请码</label><input id="invite-code" className="invite-code-input" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} maxLength={64} value={inviteCode} onChange={(event) => { setInviteCode(event.target.value); setInviteError(""); }} placeholder="XXXXX-XXXXX-XXXXX" required aria-describedby={inviteError ? "invite-error" : "invite-hint"} />{inviteError ? <span id="invite-error" className="invite-error" role="alert">{inviteError}</span> : <span id="invite-hint" className="access-hint">每个邀请码仅可使用一次</span>}<button type="submit" className="primary-button access-action" disabled={isRedeeming}>{isRedeeming ? "正在验证…" : "验证并进入"}<ArrowRight size={17} /></button></form><button type="button" className="access-demo-link" onClick={() => { setShowAccess(false); scrollToSection("studio"); }}>先看看演示 <ArrowRight size={15} /></button></div></div>}
      {toast && <div className="toast" role="status"><Sparkles size={16} />{toast}<button type="button" aria-label="关闭提示" onClick={() => setToast("")}><X size={15} /></button></div>}
    </div>
  );
}
