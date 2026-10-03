**简体中文** | [English](external-review.en.md)

# 外部代码评审（ChatGPT，2026-10）

这份文件记录了一次**外部代码评审**的原始结论，以及据此做的安全模型收紧。放在仓库里有两个用处：
一是让"为什么这样设计"有据可查，二是它列的问题里有相当一部分当时确实成立（下面标注了核实结果）。

评审方式：把整个仓库（去掉 .git 与 var 目录）加一份评审请求交给 ChatGPT，让它按
安全模型 / 架构 / 健壮性 / 工程性 / 可维护性 五个维度打分并给可执行意见。

**它给出的分数**：安全模型 5.5 · 架构 7.5 · 健壮性 7 · 工程性 7.5 · 可维护性 6.5（10 分制），
结论是"架构不用推翻，安全模型需要重新收紧；最该动的不是 snapshot，而是 bridge trust boundary"。

**核实与处置**（逐条查过代码，"属实"的都改了，并配了测试）：

| 它指出的 | 核实 | 处置 |
|---|---|---|
| setFullAccess 没校验调用者，只是"目前只有 popup 在调" | 属实 | 加 sender 白名单 + 负向测试 |
| 黑名单只管当前 URL、不管操作效果；
avigate 不校验目标 | 属实 | 窄授权改 origin 级委托：
avigate/open 事前拒绝 |
| "不可见不给 ref"只成立于快照阶段，执行层仍可直接找 DOM | 属实（TOCTOU） | 执行层 esolveTarget：可见性 + 快照签名复核 |
| MAIN world eval 让 origin 隔离失效 | 属实 | 窄授权下禁用 MAIN eval |
| 任意本地进程可伪装扩展连 /ws；/cmd 等无认证 | 属实 | 本地控制面能力令牌（HTTP + WS） |
| 端口被占用时 native host 会 relay 给"谁占着端口" | 属实，最严重 | 令牌不匹配即失败关闭（拒绝 relay 并退出） |
| 没有 per-tab 命令队列；snapshotAfter 可能拍到另一个浏览器 | 属实 | 队列 + 快照固定到"接单的浏览器" |
| 同浏览器多 Profile 都是 rowser: chrome，无法区分 | 属实 | hello 带 instance，支持 chrome@<前缀> |
| 手写 WS 解析器无帧长上限、缺畸形帧测试 | 属实 | 单帧 8MB 上限；畸形/超大帧断连 |
| ackground.js + 内嵌 PAGE_OP 已是维护债 | 属实 | **未做**（拆分需要构建步骤，先保留区块化 + 抽取测试） |

---

## 一、评审正文
### 送评材料
dsh-page-bridge-review.zip
文件
bundle-full.md
文档
思考了 3m 20s
### 评审正文
我把 bundle-full.md 里的全部源码、测试和 README 都交叉看了一遍。结论先放前面：

这个项目的架构思路是成立的，工程质量也明显高于一般个人自动化脚本；但目前“安全模型”的几个核心表述比实际实现更强。 最关键的不是快照算法，而是：本地 bridge 没有真正的身份认证、黑名单不是“效果级”阻断、ref 的不可见性只在快照阶段成立。

按 10 分制，我会给：

项目 评分 核心理由
安全模型 5.5/10 权限分层设计不错，但存在可实质绕过的控制面问题
架构 7.5/10 三层划分合理；native/WS 有价值，但 relay 是明显的复杂度热点
健壮性 7/10 针对真实 Chromium 痛点处理得很扎实，但存在 TOCTOU、并发和目标漂移问题
工程性 7.5/10 测试意识很好；CI、反例、自检都比较成熟
可维护性 6.5/10 background.js + 内嵌 PAGE_OP + 手写协议已经开始进入“以后自己也会怕改”的区间
1. 安全模型：这里有三个实质问题
1.1 「完全接管只能用户开启」目前是“调用约定”，不是强制安全边界

你现在的核心判断是：

JavaScript
if (msg?.kind === 'setFullAccess') {
 fullAccess = Boolean(msg.value);
 ...
}

也就是说，runtime.onMessage 没有验证 sender 到底是不是 popup。对应代码本身只要求消息类型正确。

而 Chrome 的消息模型本来就允许 service worker 与 content script、其他扩展上下文进行消息传递；官方文档明确把 runtime.sendMessage() 作为不同扩展上下文之间的标准通信机制。
Chrome for Developers
+1

所以现在准确的表述应该是：

“当前项目里只有 popup 调用了 setFullAccess，bridge 没有这个命令。”

而不是：

“只有用户在 popup 点才能调用。”

两者安全含义不同。

更大的问题

你实际上把“权限提升”保护在了当前没有其他调用者这一事实之上，而不是：

纯文本
sender.url === chrome.runtime.getURL("popup.html")

这样的硬条件之上。

你已经写了专门的“Agent 无法自己提权”测试，但它测的是：

纯文本
bridge → unknown command

这只能证明 bridge 不能提权，不能证明 扩展内部所有非 popup 调用者都不能提权。测试的位置在这里也能看出来。

建议

把 setter 改成真正的权限边界：

JavaScript
if (msg?.kind === 'setFullAccess') {
 if (_sender?.id !== chrome.runtime.id ||
 _sender?.url !== chrome.runtime.getURL('popup.html')) {
 reply({ ok: false, error: 'forbidden' });
 return true;
 }

 fullAccess = Boolean(msg.value);
 ...
}

然后加一个负向测试：

content-script / injected isolated world / extension page → setFullAccess 必须失败。

这才真正闭环。

2. 黑名单：这是我认为当前最重要的逻辑漏洞

你现在的黑名单检查位置本身没有问题：

JavaScript
authorizedTab()

每次命令前重新检查当前 tab 的 URL，完全接管时也检查 blockDomains。

问题在于：它检查的是“当前目标 tab”，不是“这次操作产生的效果”。

最直接的例子是 navigate：

JavaScript
const tab = await chrome.tabs.update(tabId, { url: args.url });

这里没有检查 args.url。

因此：

纯文本
当前：https://github.com
黑名单：bank.com
Agent：
page_navigate("https://bank.com")

流程实际上是：

纯文本
authorizedTab()
 ↓
检查 github.com → 允许
 ↓
tabs.update(... bank.com ...)
 ↓
真的导航
 ↓
onUpdated 才发现 origin 变了
 ↓
revoke grant

你的 enforceGrantOnNavigation() 是事后撤销，不是事前阻止。它确实会在跨 origin 时取消 grant，这一点实现得很好，但导航本身已经发生了。

所以你现在真正保证的是：

“黑名单域名上的后续 agent 操作会被拒绝。”

而不是：

“Agent 永远不能让浏览器进入黑名单域名。”

这是两个级别。

2.1 eval 进一步扩大了这个缺口

你提供了 MAIN-world eval：

JavaScript
return inject(tabId, 'eval', {
 code: args.code,
 worldName: args.world ?? 'MAIN'
}, args.world ?? 'MAIN');

而 PAGE_OP 里真正执行：

JavaScript
(0, eval)(String(args.code ?? ''))

于是即使你把：

JavaScript
page_navigate("https://bank.com")

修好，下面仍然可以：

JavaScript
location.href = "https://bank.com"

或者：

JavaScript
window.open("https://bank.com")

或者构造并提交一个表单让页面自己跳过去。

所以这是一个概念问题：

你现在其实有三种不同的安全语义
纯文本
权限边界
├─ 能不能控制这个 tab
├─ 能不能读取这个 tab
└─ 能不能让浏览器发生什么副作用

当前代码对前两层控制得不错，但第三层没有被完全纳入域名策略。

我建议你明确选择：

A. 黑名单只是“agent 控制权限”

那就承认它不是网络隔离，README 里写清楚。

或者：

B. 黑名单是“Agent 不得使浏览器进入这些域”

那就必须把：

navigate
open
click 导航
form submit
MAIN eval
window.open
页面自身触发的导航

全部纳入同一个 policy 模型。

后者明显更难，但语义才完整。

3. 「不可见元素不给 ref」这个设计是对的，但安全保证没有贯穿到执行层

你这部分设计其实很好。

快照阶段：

JavaScript
const visibleHere = vis === 'shown';

if (visibleHere && actionable) {
 ...
 ref = `e${refSeq}`;
}

不可见元素不产 ref。

而且 display:contents、visibility:hidden 后代翻盘、details、open shadow root 等都考虑到了。

这部分我认可。

但是你后面执行 ref 时：

JavaScript
const byRef = (ref) => deepQuery(`[data-dsh-ref="${ref}"]`);

然后：

JavaScript
const find = ...

最终 click 是：

JavaScript
const el = find(args.selector);
...
el.click();

没有再次做：

JavaScript
visible(el)
actionable(el)
当前 ref 仍属于当前快照

之类的检查。


这意味着：

纯文本
Snapshot A
 e12 = 可见 Delete 按钮

页面发生变化

e12 所在元素：
 被隐藏
 或 CSS 改掉
 或属性被页面脚本修改
 或 DOM 被替换/克隆

Agent → click e12

你的执行层仍可能直接拿 [data-dsh-ref="e12"] 找到并点。

更危险的一点

data-dsh-ref 是页面 DOM 属性。

这是页面自己可以改的状态。

因此当前 ref 更像：

“给网页 DOM 挂了一个模型寻址标签”

而不是：

“扩展自己拥有的可信对象引用”。

我会改成

执行前统一走：

纯文本
resolveTarget()
 ↓
找到元素
 ↓
验证仍然是当前可见 composed-tree 元素
 ↓
验证仍是 actionable
 ↓
验证 ref 所属页面/快照代次
 ↓
执行

甚至可以给 snapshot 一个 generation：

纯文本
snapshot generation = 42
ref = e12@g42

虽然不一定真的要把 @g42 暴露给模型，但内部可以检查。

4. 更严重的安全问题：你给 native messaging 建的身份边界，到了 bridge 层又被拿掉了

这是我这次评审里最想让你改的一点。

Chrome 的 native messaging 本身是有身份边界的：

JSON
"allowed_origins": [
 "chrome-extension://..."
]

Chrome 官方也明确说明 allowed_origins 用来限制哪些扩展可以访问 native host。
Chrome for Developers

你的注册器也确实正确生成了它。

但是 bridge 内部没有继续维持这个身份。

4.1 任意本地进程都可以连 /ws

bridge：

JavaScript
server.on('upgrade', ...)

收到 WS 后立即：

JavaScript
clients.add(client)

然后客户端自己发送：

JavaScript
{
 type: "hello",
 agent: "chrome-extension"
}

bridge 就：

JavaScript
client.label = msg.agent ?? 'unknown';


接下来：

JavaScript
extensionClient()

只相信：

JavaScript
c.label === 'chrome-extension'

再结合 focused / lastActive 选目标。

也就是说，一个本机恶意进程完全可以伪装成 extension client。

它甚至不需要碰 Chrome。

5. 更具体的绕过：固定 8799 被抢占时，native host 会主动把消息转给占端口的人

这个比“WS 没 token”还严重。

你的设计是：

纯文本
Chrome
 ↓ native messaging
bridge --native
 ↓
发现 8799 已被占用
 ↓
startRelay()
 ↓
ws://127.0.0.1:8799/ws

而 startRelay()：

JavaScript
handshake.on('upgrade', ...)

没有任何鉴权。

所以攻击路径可以是：

纯文本
恶意本地进程
 ↓
先绑定 127.0.0.1:8799
 ↓
Chrome 启动真正的 native host
 ↓
真正的 bridge：EADDRINUSE
 ↓
进入 relay
 ↓
主动连接恶意进程的 WS
 ↓
native hello / cmd / result 全部经过攻击者

这会让：

native messaging 带来的“只有这个扩展可以启动我”的安全优势，被 relay 重新削弱。

而且 EADDRINUSE → relay 是明确设计出来的行为，不是偶发 bug。

我的建议很直接

不要让 native host 无条件 relay 到任何占用 8799 的 WS 服务。

三个选择里，我偏向：

纯文本
native host
 ↓
认证过的本地 bridge

而不是：

纯文本
native host
 ↓
“谁占 8799 我就连谁”

最简单的方案是给本地 bridge 一个随机 capability token。

HTTP：

http
Authorization: Bearer <random-token>

WS handshake 也必须知道同一 token。

这样：

纯文本
127.0.0.1 ≠ trusted

只有拿到 capability 才 trusted。

6. /cmd、/events、/state、/shutdown 全部没有认证

你的 HTTP 层是：

纯文本
GET /status
GET /events
GET /state
POST /cmd
POST /shutdown

而 /cmd 直接：

JavaScript
dispatch(body.name, body.args ...)

没有 token / session / caller identity。

这意味着本机任何程序都可以：

纯文本
GET /events
GET /state
POST /cmd
POST /shutdown

尤其是：

纯文本
/events
/state

会暴露页面元数据；

而：

纯文本
/cmd

是实际控制入口。

所以你 README 里的：

“浏览器侧不再监听端口，因此没有做 token 校验”

我会建议改成：

“浏览器侧不再监听端口，因此不需要浏览器入口 token；但 bridge 本地控制面仍需要身份认证。”

这是更准确的安全模型。

7. bridge 的 WebSocket 自研协议：零依赖值得，但目前已经开始进入危险区

我支持你最开始不用依赖的决定。

因为你的核心目的之一就是：

纯文本
Native Node runtime
+
不引入 npm runtime dependency
+
安装简单

这个目标合理。

但是现在 bridge.mjs 已经自己实现：

WebSocket handshake
text frame
masking
64-bit length
control frame
native framing
relay
client routing

问题不在代码长度，而在协议边界。

当前测试主要证明：

纯文本
正常帧可以往返

而不是：

纯文本
畸形帧无法拖死 bridge

我目前没看到针对以下情况的测试：

纯文本
fragmented frame
continuation frame
RSV bits
超大 127-length frame
> 65535 的 relay outbound frame
control frame 超长
未 mask 的 client frame
恶意 JSON flood
半截 header 永不结束
持续增长的 receive buffer

而 decodeFrames() 对 frame length 没有自己的硬上限。

所以这里有两个可接受路线

路线 A：继续零依赖

那就把 parser 独立出来，然后加：

纯文本
protocol-fuzz-test
malformed-frame-test
size-limit-test
fragmentation-test

路线 B：允许一个 runtime dependency

直接采用成熟 WS 实现。

对于一个个人内部工具，我不要求你必须选 B；但如果未来要公开给更多用户，我会重新考虑“零依赖”与“自己实现协议”的交换是否值得。

8. PAGE_OP 的设计很聪明，但已经开始成为维护债务

这个函数现在实际上同时承担：

纯文本
ARIA snapshot
shadow DOM traversal
ref allocation
state
text
html
eval
click
key
type
select
scroll
highlight
wait
count

而且为了测试，你又通过：

纯文本
#region
 ↓
regex extract
 ↓
new Function(...)

把它拆出来执行。

这种方法短期非常实用，我不反对。

但从维护角度，它已经说明一个事实：

background.js 已经不是一个 service worker 文件，而是整个浏览器执行引擎。

1253 行也印证这一点。你的 CI 确实有很好的回归测试，但代码结构本身已经接近需要拆分的程度。

我不会现在为了“架构漂亮”重构。

但下一阶段应该考虑：

纯文本
background/
 transport.js
 policy.js
 authorization.js
 tabs.js
 page-op/
 snapshot.js
 actions.js
 refs.js

然后最终生成一个 MV3 service-worker 文件。

9. Chrome + Edge 的处理是对的，但你下一个坑其实是“两个 Chrome”

你现在：

纯文本
Chrome → browser=chrome
Edge → browser=edge

再加：

纯文本
focused
lastActive
page_use_browser

这一套，针对 Chrome+Edge 是合理的。

尤其是你专门排除了 heartbeat 对 lastActive 的污染，这个修正是对的。

但还有一个没有被解决的问题：

纯文本
Chrome Profile A
Chrome Profile B

两个都会发：

纯文本
browser = chrome

于是：

JavaScript
return list.find((c) => c.browser === browser)

仍然不唯一。

同理：

纯文本
Edge Profile A
Edge Profile B

也一样。

我建议 hello 增加：
纯文本
browser
profileInstanceId
connectionId

例如：

JSON
{
 "type": "hello",
 "browser": "chrome",
 "instance": "5e3b..."
}

以后 page_use_browser 就不应该再只是：

纯文本
chrome
edge

而是：

纯文本
chrome#5e3b...
edge#8af1...

这会彻底解决“tabId 只是浏览器内唯一，而不是机器全局唯一”的问题。

10. 还有一个很实际的并发问题：没有 per-tab 命令队列

这是我认为你现在尚未充分考虑的健壮性问题。

假设同时来了：

纯文本
page_click A
page_type B
page_snapshot
page_click C

现在 onTransportMessage() 是：

JavaScript
const result = await handle(...)

每个 message 自己 async，并没有看到一个：

纯文本
tab 1 command queue

于是可能出现：

纯文本
click A
 ↓
页面开始 React 更新

type B
 ↓
snapshot
 ↓
click C

执行顺序和模型看到的顺序不再一定一致。

尤其你的：

纯文本
snapshotAfter()

还是异步等待 250/900ms 后再重新找当前 browser。

于是出现一种很现实的情况：

纯文本
T0 action 发到 Chrome
T1 用户切到 Edge
T2 snapshotAfter()
T3 snapshot 发给 Edge

最终模型拿到：

“刚才 GitHub 的 click 后快照”

实际上却是：

Edge 当前页面快照

你的 page_use_browser 可以缓解，但默认模式还是可能发生。

解决方式

至少做：

纯文本
session
 └─ browser connection
 └─ tab command queue

并让一次 action + snapshot 绑定到同一个 connection。

11. Service Worker 的处理：方向正确，但有两个风险

你处理：

纯文本
20s heartbeat
30s alarm
native probe
WS fallback
retry backoff

这部分很扎实。

但：

风险 1：native probe 只有 900ms
JavaScript
setTimeout(() => {
 if (!sawMessage && nativePort === port) {
 port.disconnect();
 }
}, 900);

在正常机器上可能完全够，但它实际上是：

纯文本
900ms 内没握手成功
→ 判定 native 没用
→ WS fallback

这让“慢启动”变成“假失败”。

建议不是简单改成 5 秒，而是：

纯文本
CONNECTING
 ↓
HELLO_SENT
 ↓
PROBING 2~3s
 ↓
NATIVE
 ↓
FAILED → WS

做成明确状态机。

12. 快照算法本身：这是项目里我最认可的一块

这里我基本没有大的负面意见。

你没有简单使用：

JavaScript
getBoundingClientRect()

一刀切，而是区分：

纯文本
hidden
flat
shown

这解决了：

display: contents
visibility:hidden → child visible
shadow root
<details>
ref 稳定编号

这些是真实浏览器自动化里很容易踩的坑。

尤其你做的反例：

纯文本
旧 ref 是否漂移
旧写法 key 是否提交
不可见 ref 是否进入 snapshot
details 折叠内容是否泄漏
shadow root 是否能看到

比单纯测“正常 case”有价值得多。自检表也确实体现了这一点。

13. 但是 html 和 eval 意味着“不可见内容”仍然可能被读出来

你把：

纯文本
snapshot 不展示 invisible

设计得很好。

但：

纯文本
page_html
page_eval
page_text

并没有共享这个可见性语义。

例如 html 明确返回：

JavaScript
document.documentElement.outerHTML

以及所有 open shadow roots。

所以：

纯文本
“看不见的按钮不给 ref”

与：

纯文本
“Agent 看不到不可见内容”

不是一回事。

如果你要把它定义成交互安全，没问题。

如果你想把它定义成数据泄露安全，目前并没有成立。

14. 测试策略：很好，但仍然有明显盲区

你现在的测试重点是：

纯文本
已知踩过的坑

这个策略是对的。

CI 里确实已经覆盖：

policy
SW 状态机
native framing
extension ID
MCP smoke

而真实浏览器的：

纯文本
snapshot-probe
native-e2e

明确没有进 CI。

这不是错，但意味着：

12/12 green 并不等于“浏览器链路全绿”。

README 已经诚实写明了这个限制，所以我不会指责 CI 标绿具有误导性。

我会新增这 8 个测试

其中前 5 个优先级最高：

纯文本
1. navigate → blocklisted destination
2. eval("location.href = blocklisted")
3. hidden element → direct CSS selector click
4. stale ref after DOM replacement
5. malicious localhost WS client impersonation
6. port 8799 pre-bind → native relay hijack
7. two Chrome profiles simultaneously
8. concurrent commands on same tab

特别是第 5、6 项，目前的测试矩阵没有覆盖到真正的攻击模型。

15. 事件日志还有一个小但真实的工程问题

你内存里：

JavaScript
MAX_EVENTS = 500

确实只保留 500 条。

但磁盘：

JavaScript
appendFileSync(LOG_FILE, ...)

是无限追加。

所以：

纯文本
events[] = rolling 500
events.jsonl = unbounded

而 README 又把它描述成滚动记录。

这不是安全灾难，但属于“实现语义和文档语义不完全相同”。

更好的做法：

纯文本
events-YYYYMMDD.jsonl

或者达到例如：

纯文本
10 MB

就 rotate。

这样隐私边界也更清楚。

16. 可移植性：你的设计基本可行，但用户会遇到四类坑

注册器这部分总体是合理的：

纯文本
%APPDATA%
HKCU
绝对 launcher
allowed_origins

而且 allowed_origins 只允许具体 extension ID，这符合 Chrome native messaging 的设计。
Chrome for Developers

换目录

这是最大的：

纯文本
.
 ↓
.

unpacked extension ID 改变。

你自己已经明确测试了这一点。

所以：

纯文本
换目录
→ extension ID 改
→ allowed_origins 旧
→ native 失效

必须重新注册。

换机器

同样：

纯文本
用户目录
绝对路径
Node 路径
registry
manifest

全部可能改变。

尤其 launcher 是直接写：

cmd
"<当前 process.execPath>" "<项目路径>\bridge.mjs" --native

所以升级 / 删除 DSH runtime 后，这个 launcher 可能立即失效。

换浏览器

Chrome / Edge 你已经处理得很好，因为二者注册路径分别维护。

但你代码又识别：

纯文本
brave
opera

而 register-host.mjs 并没有这两个 vendor。

所以这两类最终仍会退化到 WS。

这应该在 README 里写得更明显：

纯文本
Chrome / Edge = native supported
Brave / Opera = WS fallback
自定义 Chromium profile

discoveredIds() 只扫描：

纯文本
Default
Profile *

这对辅助诊断可以，但自定义 profile 名并不在扫描范围内。

这不是注册本身的 bug，但可能造成：

“明明装了扩展，诊断脚本却说没找到。”

17. native + WS：我认为“有必要”，但 relay 有点过设计

我的判断是：

native + WS

值得保留。

因为它解决了两个不同的问题：

纯文本
native
→ 正式安装 / 最好生命周期 / 无浏览器监听端口

WS
→ 免注册 / 开发 / 故障回退

这个组合很有实际价值。

host + relay

我就没这么肯定了。

你现在为了：

纯文本
bridge 已经运行
+
Chrome 又启动 native host

设计了：

纯文本
native host
 ↓
WS relay
 ↓
已有 bridge

这确实很巧。

但它带来的代价恰好集中在最敏感的地方：

纯文本
身份认证
端口劫持
协议转换
双重 framing
错误处理
生命周期

所以我的评价是：

native + WS 是工程上的冗余；native→WS relay 是安全上的复杂度。

如果未来只允许你删一套，我反而会先删 relay，而不是删 WS。

18. 我会怎么重新画安全边界

现在你的安全边界更像：

纯文本
 Chrome
 │
 native messaging
 │
 [有身份验证]
 │
 bridge
 / \
 HTTP WS
 [无认证] [无认证]
 \ /
 tools

我建议目标变成：

纯文本
 Chrome
 │
 native messaging
 │
 [extension ID]
 │
 bridge
 ┌──────┴──────┐
 │ capability │
 │ auth │
 └──────┬──────┘
 │
 router / queue
 │
 ┌─────────┴─────────┐
 │ │
 MCP / CLI extension
 │
 authorization policy
 │ │ │
 grant domain target

也就是：

native messaging 是浏览器→host 的认证。

capability token 是 host/bridge 内部控制面的认证。

这两个不要混成一个。

19. 如果只允许改三件事

我的排序不是“功能优先”，而是按安全收益：

第一件：给 bridge 控制面加真正的身份认证，并废掉未经认证的 relay

这是第一优先级。

至少：

纯文本
POST /cmd
GET /events
GET /state
POST /shutdown
WS /ws

都不能只靠：

纯文本
127.0.0.1

来建立信任。

而且必须测试：

纯文本
恶意进程先占 8799
→ native host
→ 不应该把 native 流量送给它

这是我认为当前最严重的实际攻击路径。

第二件：把 domain policy 从“当前 tab 检查”升级成“操作效果检查”

最低限度先做：

纯文本
navigate(target URL) → 先检查
open(target URL) → 已经检查，保持

然后明确处理：

纯文本
MAIN eval
click → navigation
form submit
window.open

如果你不准备做完整的“导航防火墙”，那就把文档改成：

黑名单限制 Agent 对当前页面的进一步操作，不保证阻止页面发生网络导航。

现在这个语义是最重要的。

第三件：把 ref / action 做成一次性的可信目标解析

统一：

纯文本
resolve
 ↓
visible?
 ↓
actionable?
 ↓
same target?
 ↓
execute

不要再：

纯文本
snapshot 时 visible
↓
执行时只查 data-dsh-ref

同时把：

纯文本
per-browser
per-tab
command queue

一起做掉。

这样你会同时解决：

纯文本
stale ref
hidden ref
Chrome/Edge 漂移
并发 action
snapshot 跑到另一浏览器

这一大类问题。

最后的评审结论

我不会建议你推翻这个项目。

恰恰相反，我认为它现在已经进入了一个很明确的阶段：

纯文本
v0.x：
“能不能把正在用的浏览器接进 Agent？”
 ↓
已经解决

现在：
“如何让这个连接形成真正可信的安全边界？”
 ↓
这是下一阶段

目前最值得肯定的不是“功能多”，而是你已经开始用反例测试思考真实浏览器自动化：隐藏容器、shadow DOM、React keyCode、MV3 休眠、Chrome/Edge tabId、ref 漂移，这些都不是随便写个 demo 会遇到的。

但安全边界现在有三个地方出现了“名字比实现更强”的情况：

纯文本
“popup-only” → 实际是“当前只有 popup 调用”
“blacklist active” → 实际是“命令前检查当前 URL”
“invisible has no ref”
 → 实际是“快照里没有 ref，但执行层仍可直接找 DOM”

这三处一旦修正，再把 bridge 身份认证 / relay 劫持补上，我会认为它的安全模型才真正配得上“真实驱动用户登录浏览器”的定位。

另外，Chrome 官方的 native messaging 确实已经提供了 allowed_origins 这一层来源限制；你的实现正确利用了它，但这层认证不能自动延伸到你自己开的 localhost HTTP/WS 控制面。
Chrome for Developers

一句话评价：架构不用推翻，安全模型需要重新收紧；最该动的不是 snapshot，而是 bridge trust boundary。

你目前已用完附件额度。请升级套餐获取更多额度，或在 明天 17:19 后 后重试。

---

## 二、关于语义选择的追问与回答

### 我的追问
接着你的评审，先问一个我不想自己拍板的问题（其余 P0 我已经在改了：bridge 能力令牌、setFullAccess 的 sender 白名单、执行层 resolveTarget）。

**关于黑名单语义 A/B：**

1. 你建议**先做 A**（只改文档，承认"黑名单只约束 agent 的控制权限，不保证阻止页面发生网络导航"）还是**直接做 B**（导航防火墙）？理由是什么？

2. 如果做 B，你建议的**最小可行集合**是什么？下面这些通路里，哪些是必须先堵、哪些可以接受"文档说清就行"：
 - page_navigate（我自己的命令）
 - page_open（新开标签页）
 - page_click 点到一个链接/按钮导致的导航
 - 页面自己 form submit
 - MAIN world 的 eval（location.href = ...）
 - window.open

3. 我想到一个**中间挡位**：在窄授权（共享单个标签页）下，navigate 只允许**同 origin** 的目标（SPA 路由仍可用），跨 origin 直接拒绝并提示"请重新共享"；完全接管模式下只校验黑名单。你觉得这个挡位合理吗？还是有更省事又更严谨的做法？

不需要重发源码，你已经看过全部代码了。


### ChatGPT 的回答
我的建议是：不要做纯 A，也不要现在就做“完整 B”。你提出的中间挡位更合适，但我会把它正式定义成：

窄授权 = origin-bound（共享标签页绑定到 origin）
完全接管 = browser-wide control + denylist

这是我认为目前最省事、又最容易长期维持正确语义的方案。

1. A / B 选哪个？

我选你提出的中间挡位，而不是纯 A 或完整 B。

原因有两个。

第一，纯 A 会让“黑名单”这个词越来越容易被误解。现在 authorizedTab() 确实每次都会重新检查当前 URL；而导航本身是在授权当前 tab 后才执行，之后 enforceGrantOnNavigation() 才发现跨 origin 并撤销共享。也就是说它现在是事后收权，不是导航前阻断。


第二，完整 B 会迅速变成“浏览器网络防火墙”项目。你现在已经有 MAIN eval，它可以直接执行 location.href、window.open，而 click 也可能由页面自己的 JS 产生未知副作用。PAGE_OP 目前确实允许 MAIN eval，click 也直接调用页面元素的 click()。

所以完整 B 的真正问题不是 page_navigate 好不好堵，而是：

你要不要承诺“页面永远不能把浏览器带进黑名单域名”。

一旦承诺这个，就必须考虑网络层/导航层，而不只是 MCP 命令。

2. 我建议的正式语义

我会把权限模型定成这样：

通路 窄授权 完全接管
读/操作当前 tab 允许 允许
page_navigate 同 origin 允许 允许
page_navigate 跨 origin 拒绝 允许，但黑名单拒绝
page_open 建议只允许 same-origin，或直接要求完全接管 允许，但黑名单拒绝
click 导航 允许，但不能主动把它当作“跨 origin 授权” 允许，但黑名单规则仍生效
form submit 同上 同上
MAIN eval 建议禁用 允许
window.open 与 eval 一样 允许
黑名单域 始终拒绝 始终拒绝

这里最关键的是：

窄授权不是“共享了一个 tab 就能控制这个 tab 去任何地方”，而是“共享了这个 origin”。

这其实非常契合你现在已经实现的 grant 设计，因为共享记录本身就保存了：

纯文本
tabId
origin
url
title
grantedAt

而导航后已有代码会比较当前 origin 和 grant origin。


所以你不是另起炉灶，而是把现有模型从“事后 revoke”前移成“事前 deny”。

3. 六条通路，我建议具体这样处理
page_navigate

必须堵。

这是最便宜、收益最高的一条。

窄授权下：

纯文本
target origin === grant.origin
 → 允许

target origin !== grant.origin
 → 立即拒绝
 → 提示“需要重新共享该标签页”

完全接管：

纯文本
target ∉ blocklist → allow
target ∈ blocklist → deny

这一条我认为应该是 P0/P1 级别。

page_open

这里我建议比你原来的想法再严一点：

窄授权下：

只允许 same-origin，或者干脆要求完全接管。

原因是“打开新标签页”本质上也是 agent 主动选择新的浏览目标。

现在 open 的实现已经是：

纯文本
窄模式：
只要有 grant
→ 就允许打开任意非黑名单 HTTP URL

而它本身还不受 authorizedTab() 那个 tabId === grant.tabId 的限制，因为 open 是特殊分支。

这实际上意味着目前窄模式并不是严格的单 origin 委托。

所以我的推荐是：

窄授权 = open 的目标也必须与 grant origin 相同。

例如共享 github.com：

纯文本
github.com/... ✓
api.github.com ✗
google.com ✗

而不是只靠黑名单。

page_click

这里我不建议你一开始就做“完美阻断”。

因为：

JavaScript
el.click()

之后到底去哪儿，可能由：

<a href>
JS handler
React handler
router
framework middleware

共同决定。现有实现就是直接触发页面 click。

最小可行做法

允许 click，但把“导航是否跨 origin / 进入黑名单”纳入 action 的后置检查。

也就是：

纯文本
before URL
 ↓
click
 ↓
wait tiny settle
 ↓
after URL
 ↓
if blocked → revoke
if narrow && origin changed → revoke + report

这样：

纯文本
Agent 不能通过 click 获得一个长期的新 origin 控制权。

但是我要明确：

这不是“绝对不让浏览器发出第一次请求”，而是“click 之后立即撤销跨 origin 委托”。

如果以后你决定 B 的定义是“黑名单域一律不得产生网络请求”，那时才需要升级成真正的网络/导航层拦截。

页面自己 form submit

和 click 同级处理。

我不会为了它现在引入复杂的浏览器导航防火墙。

做：

纯文本
submit
→ 等一小段
→ 检查最终 origin
→ 窄模式跨 origin → revoke
→ 黑名单 → revoke

就够了。

原因是 form 提交同样存在大量“页面自己决定 destination”的情况。

4. MAIN eval 是唯一我认为必须区别对待的

这里我会非常明确：

窄授权下，禁用 MAIN eval

因为现在：

JavaScript
(0, eval)(String(args.code ?? ''))

它不是“一个导航 API”，而是任意 JS 能力。

所以你如果在窄授权下允许：

JavaScript
location.href = ...

那么所谓：

“窄模式只能操作这个 origin”

其实立刻失效。

你当然可以说：

eval 是高级逃生舱，用户自己承担风险。

那就应该把它明确变成一个独立的权限：

纯文本
窄模式
├─ DOM read/write ✓
├─ same-origin nav ✓
└─ MAIN eval ✗

完全接管
└─ MAIN eval ✓

我认为这比尝试“解析 eval 字符串，看它是不是导航”严谨得多。

因为：

JavaScript
location.href = foo()

和：

JavaScript
window[method](...)

这种东西根本没必要继续追。

5. window.open

直接沿用 eval 的规则。

也就是：

窄授权：
纯文本
MAIN eval → 禁止

因此自然没有：

纯文本
eval → window.open()

这个逃逸口。

完全接管：

允许，但目标 URL 经过 blocklist policy。

所以你不需要给 window.open 单独再设计一套权限模型。

6. 这样一来，你实际上得到的是一个很干净的三级模型

我会把它定成：

纯文本
Level 0
未共享
→ 不能读/操作页面

Level 1
共享 origin
→ 只能操作这个 origin
→ 不能 MAIN eval
→ 不能主动跨 origin open/navigate
→ click/form 可以发生页面自行导航，但一旦跨 origin，立即撤销授权

Level 2
完全接管
→ 任意 tab / 任意 origin
→ 但 blocklist 永远有效
→ MAIN eval 开放

这个模型最大的好处是：

权限语义非常容易解释。

用户只需要记：

“共享 = 把这个网站交给 Agent。”
“完全接管 = 把整个浏览器交给 Agent。”
“黑名单 = 完全接管也不能碰的域。”

这比“黑名单同时是网络防火墙、导航防火墙、权限防火墙、页面内容过滤器”要清晰得多。

7. 那什么时候才值得真的做完整 B？

我建议暂时不要。

只有在将来你真的需要这个承诺：

“无论 Agent 通过什么方式，黑名单域都不能发生顶层导航/网络访问。”

才值得引入第二层真正的浏览器网络策略。

到那个时候可以考虑：

纯文本
Agent command policy
+
browser navigation policy
+
network request policy

甚至把 denylist 统一放到浏览器级规则里。

但这已经不是你目前这个 Page Bridge 的“小修”，而是安全模型升级了。

最终决定

所以我替你拍板：

现在不要选 A，也不要上完整 B。

直接做你提出的中间挡位，但稍微收紧成：

窄授权按 origin 隔离；完全接管按 denylist 隔离。

具体就是：

必须先堵：

纯文本
page_navigate
page_open（窄模式至少同 origin）
MAIN eval（窄模式直接禁）

允许后置检查：

纯文本
page_click
form submit

window.open 不单独处理：

纯文本
窄模式随 MAIN eval 一起禁
完全接管随 eval 一起开放，但受 denylist 约束

这样你不用把项目突然变成“浏览器网络防火墙”，又能让“共享一个标签页”真正升级成一个可信的 origin-scoped capability。

而且这个方案和你现在已经存在的 grant.origin、跨 origin 自动 revoke、完全接管继续检查 blocklist 的代码结构是直接衔接的，不需要推翻现有架构。
