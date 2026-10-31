/** Copy selection is local and bounded: no network or generated claims about the family. */
export type Greeting = { salutation: string; message: string };
type Period = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night';
const messages: Record<Period | 'weekend' | 'resume', readonly string[]> = {
  morning: [
    '今天也有新故事。', '新的一天，慢慢开始。', '早呀，愿今天有小小的惊喜。', '带着好奇心，开始新的一天。',
    '早晨的问候，先送给你。', '睡醒啦，今天想认识谁？', '给今天留一点想象力。', '故事里的朋友，也来问早啦。',
    '不着急，慢慢挑。', '今天的好奇心，准备好了吗？',
  ],
  noon: [
    '中午啦，歇一小会儿。', '忙了半天，坐下来放松一下。', '给午后留一点轻松。', '故事不赶时间，慢慢挑。',
    '找个舒服的位置吧。', '休息一下，再去发现新鲜事。', '今天也辛苦啦，放松一会儿。', '给自己一段小小的休息。',
    '安静一会儿，也很好。', '想听故事，还是先伸个懒腰？',
  ],
  afternoon: [
    '找个舒服的位置吧。', '让下午多一点想象力。', '挑个喜欢的，慢慢看。', '一个小故事，一段轻松时光。',
    '今天想认识哪位新朋友？', '好奇心，又有新去处了。', '给今天添一点小惊喜。', '故事在这里，不着急。',
    '坐舒服了吗？', '愿这个下午，轻轻松松。',
  ],
  evening: [
    '忙完一天，来点轻松的故事。', '今天辛苦啦，坐下来歇歇。', '和家人一起，慢慢挑个故事。', '留一点时间，给喜欢的故事。',
    '把今天的忙碌，轻轻放一放。', '找个舒服的位置，放松一下。', '今天有没有遇到有趣的事？', '一起度过一小段好时光。',
    '愿今晚，轻松一点。', '看一会儿，也记得让眼睛歇歇。',
  ],
  night: [
    '好故事也可以留到明天。', '今天就慢一点，早点休息。', '故事不会走远，明天再见。', '让眼睛歇歇吧。',
    '愿今晚有个轻轻软软的梦。', '今天辛苦啦，好好休息。', '把好奇心留一点给明天。', '故事先收好，明天接着聊。',
    '不着急，明天还有好时光。', '晚安，愿你睡得香香的。',
  ],
  weekend: [
    '今天慢一点，挑个喜欢的故事。', '周末啦，和家人待一会儿。', '给周末留一段轻松时光。', '今天不赶路，故事慢慢挑。',
    '一起看故事，也一起聊聊天。', '周末的小惊喜，就从好奇开始。', '看一会儿，也去外面走走吧。', '给玩耍留点时间，也给故事一点。',
    '舒服地坐好，享受这一小会儿。', '愿这个周末，有喜欢的小事。',
  ],
  resume: [
    '上次的故事，还等着你接着看。', '想接着看，还是换个新故事？', '上次看到哪儿，我们帮你记着。', '喜欢的故事，可以慢慢看完。',
    '故事还在，上次的进度也在。', '要和上次的朋友再见个面吗？', '上次的冒险，还没结束呢。', '想知道后面发生了什么吗？',
    '从上次停下的地方，接着聊吧。', '熟悉的故事，也可以再回味。',
  ],
};
export function greetingPeriod(date: Date): Period {
  const hour = date.getHours();
  return hour < 5 || hour >= 21 ? 'night' : hour < 11 ? 'morning' : hour < 14 ? 'noon' : hour < 18 ? 'afternoon' : 'evening';
}
export function salutation(date: Date): string {
  return { morning: '早上好', noon: '中午好', afternoon: '下午好', evening: '晚上好', night: '夜深啦' }[greetingPeriod(date)];
}
export function greetingCandidates(date: Date, hasResume: boolean): readonly string[] {
  const period = greetingPeriod(date);
  if (period === 'night') return messages.night;
  // At least half the bag remains about the current time; context adds variety.
  return [...messages[period], ...messages[period], ...([0, 6].includes(date.getDay()) ? messages.weekend : []),
    ...(hasResume ? messages.resume : [])];
}
const historyKey = 'mollytime.tv.greeting-history.v1';
export function chooseGreeting(date: Date, hasResume: boolean, storage?: Pick<Storage, 'getItem' | 'setItem'>, random = Math.random): Greeting {
  let recent: string[] = [];
  try {
    const saved: unknown = JSON.parse(storage?.getItem(historyKey) || '[]');
    if (Array.isArray(saved)) recent = saved.filter((entry): entry is string => typeof entry === 'string').slice(-6);
  } catch { /* Private mode and malformed local state must not prevent a greeting. */ }
  const candidates = greetingCandidates(date, hasResume);
  const fresh = candidates.filter(message => !recent.includes(message));
  const pool = fresh.length ? fresh : candidates.filter(message => message !== recent[recent.length - 1]);
  const message = pool[Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)))];
  try { storage?.setItem(historyKey, JSON.stringify([...recent, message].slice(-6))); } catch { /* In-memory selection still works. */ }
  return { salutation: salutation(date), message };
}
