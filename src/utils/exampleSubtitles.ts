import { ExampleSubtitle } from "../types";

export const EXAMPLE_SUBTITLES: ExampleSubtitle[] = [
  {
    id: "colloquial-drama",
    title: "Everyday Conversational & Idioms",
    description: "Features typical colloquial Chinese phrases, slang, and idiomatic expressions like '气死我了' and '真有你的'.",
    content: `1
00:00:01,200 --> 00:00:03,500
今天真是气死我了，居然碰上这种事！

2
00:00:03,800 --> 00:00:06,100
哎呀，算了算了，别跟那种人计较。

3
00:00:06,500 --> 00:00:08,900
你站着说话不腰疼！要是你，你能忍得住？

4
00:00:09,200 --> 00:00:11,600
我懂你的心情，但吃一堑长一智，以后防着点。

5
00:00:12,000 --> 00:00:14,200
说得倒容易。不过，今天还是多亏了你。

6
00:00:14,500 --> 00:00:16,800
真有你的！每次关键时刻都这么靠谱。

7
00:00:17,200 --> 00:00:20,000
我们俩谁跟谁啊？说这些客气话就见外了。

8
00:00:20,500 --> 00:00:22,800
行了，今晚我请客，带你去撸串！

9
00:00:23,200 --> 00:00:25,500
说曹操曹操就到，阿强给我打电话了。

10
00:00:25,800 --> 00:00:28,000
估计他又想来蹭饭了，哈哈。`
  },
  {
    id: "romantic-drama",
    title: "Heartfelt Romantic Drama",
    description: "An emotional dialogue from a romantic scene, requiring warm, intimate, and affectionate Khmer phrasing.",
    content: `1
00:01:12,400 --> 00:01:15,000
其实……我心里一直都有你。

2
00:01:15,500 --> 00:01:18,200
你现在说这些，还有什么意义呢？

3
00:01:18,800 --> 00:01:21,500
我知道我以前很幼稚，总是让你伤心。

4
00:01:22,000 --> 00:01:24,800
但我真的在努力改变，不要推开我好吗？

5
00:01:25,300 --> 00:01:28,000
傻瓜，我怎么舍得真的生你的气。

6
00:01:28,500 --> 00:01:31,500
真的吗？那我们……重新开始，好不好？

7
00:01:32,000 --> 00:01:35,000
一言为定，以后再也不许丢下我一个人了。

8
00:01:35,500 --> 00:01:38,500
放心吧，无论发生什么，我都会陪着你。`
  },
  {
    id: "historical-action",
    title: "Historical & Professional Action",
    description: "A tense scenario requiring polite, formal, or epic translation styles with clear respect structures.",
    content: `1
00:03:45,000 --> 00:03:47,200
启禀将军，前方斥候发现敌军踪迹！

2
00:03:47,500 --> 00:03:49,800
哦？有多少兵力？距离此处还有多远？

3
00:03:50,200 --> 00:03:53,000
约有五千步骑，正全速朝我军营地奔袭而来。

4
00:03:53,500 --> 00:03:55,800
哼，来得正好！传我将令，全军戒备！

5
00:03:56,200 --> 00:03:58,500
遵命！属下这就去安排。

6
00:03:59,000 --> 00:04:01,800
诸位将士，胜败在此一举，随我迎敌！`
  },
  {
    id: "sami-drama-smi",
    title: "SAMI (.smi) Multi-Track Drama",
    description: "Real-world SAMI (.smi) format with track styling (.ZHCC / .ENCC) and dialogue timing.",
    content: `<SAMI>
<HEAD>
<TITLE>Modern Mechanic in Ancient Times - Season 3</TITLE>
<STYLE TYPE="text/css">
<!--
P { font-family: sans-serif; text-align: center; }
.ZHCC { Name: Chinese; lang: zh-CN; SAMIType: CC; }
.ENCC { Name: English; lang: en-US; SAMIType: CC; }
-->
</STYLE>
</HEAD>
<BODY>
<SYNC Start=1200><P Class=ZHCC>第三季：现代机修工穿越到了古代
<SYNC Start=3800><P Class=ZHCC>&nbsp;
<SYNC Start=4200><P Class=ZHCC>凭着现代智慧，帮助村姑妻子改变命运
<SYNC Start=7600><P Class=ZHCC>&nbsp;
<SYNC Start=8000><P Class=ZHCC>夫君，这辆水车真的能把河水引上高坡吗？
<SYNC Start=11500><P Class=ZHCC>&nbsp;
<SYNC Start=12000><P Class=ZHCC>娘子放心，有我在，保证今年的稻田丰收！
<SYNC Start=15800><P Class=ZHCC>&nbsp;
<SYNC Start=16200><P Class=ZHCC>不好了！隔壁村的恶霸带人来抢我们的水渠了！
<SYNC Start=20500><P Class=ZHCC>&nbsp;
<SYNC Start=21000><P Class=ZHCC>哼，敢动我娘子的心血，看我怎么收拾他们！
<SYNC Start=25000><P Class=ZHCC>&nbsp;
</BODY>
</SAMI>`
  }
];
