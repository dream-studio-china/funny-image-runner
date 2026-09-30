export type Preset = {
  id: string;
  version: number;
  name: string;
  subtitle: string;
  description: string;
  image: string;
  tint: string;
  accent: string;
  tag: string;
  promptLabel: string;
  promptPlaceholder: string;
  moods: string[];
};

// Public display metadata only. Real workflow mapping belongs to the future worker.
export const presets: Preset[] = [
  {
    id: "cloud-nine",
    version: 1,
    name: "云端漫游",
    subtitle: "DREAMSCAPE",
    description: "把平凡瞬间，藏进柔软的云与日落里。",
    image: "/art/cloud-nine.svg",
    tint: "#e4dcf8",
    accent: "#7552bb",
    tag: "人气精选",
    promptLabel: "想加入画面的奇妙元素",
    promptPlaceholder: "比如：一颗漂浮的星球、一只打盹的小猫…",
    moods: ["梦幻", "温柔", "神秘"],
  },
  {
    id: "pop-poster",
    version: 1,
    name: "复古画报",
    subtitle: "POP POSTER",
    description: "高饱和色彩，做自己生活的封面人物。",
    image: "/art/pop-poster.svg",
    tint: "#f9dcba",
    accent: "#dc663e",
    tag: "新灵感",
    promptLabel: "想出现在画报上的文字",
    promptPlaceholder: "比如：今天也要闪闪发光…",
    moods: ["俏皮", "大胆", "怀旧"],
  },
  {
    id: "soft-clay",
    version: 1,
    name: "软萌捏捏",
    subtitle: "SOFT CLAY",
    description: "像刚出炉的黏土玩偶，圆润又可爱。",
    image: "/art/soft-clay.svg",
    tint: "#dceee7",
    accent: "#528f7c",
    tag: "治愈系",
    promptLabel: "给画面加一点什么",
    promptPlaceholder: "比如：小雏菊、彩色气球…",
    moods: ["元气", "软萌", "安静"],
  },
  {
    id: "ink-story",
    version: 1,
    name: "墨色物语",
    subtitle: "INK STORY",
    description: "留白与笔触，让照片长出故事感。",
    image: "/art/ink-story.svg",
    tint: "#e8e4df",
    accent: "#696078",
    tag: "艺术感",
    promptLabel: "想表达的画面情绪",
    promptPlaceholder: "比如：下雨天的散步、宁静的午后…",
    moods: ["诗意", "静谧", "洒脱"],
  },
];
