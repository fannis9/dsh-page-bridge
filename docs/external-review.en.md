**English** | [简体中文](external-review.md)

# External Code Review (ChatGPT, 2026-10)

This file records the raw conclusions of an **external code review**, and the tightening of the security model done on that basis. Putting it in the repository serves two purposes:
first, it makes "why it is designed this way" verifiable; second, a considerable portion of the problems it lists did indeed hold at the time (the verification results are noted below).

Review method: hand over the entire repository (with the .git and var directories removed) plus a review request to ChatGPT, and have it score along five dimensions — security model / architecture / robustness / engineering / maintainability — and give actionable advice.

**The scores it gave**: security model 5.5 · architecture 7.5 · robustness 7 · engineering 7.5 · maintainability 6.5 (out of 10),
with the conclusion "the architecture does not need to be overturned; the security model needs to be tightened again; what most needs changing is not the snapshot, but the bridge trust boundary".

**Verification and handling** (checked the code item by item; everything "true" was fixed, with tests added):

| What it pointed out | Verification | Handling |
|---|---|---|
| setFullAccess does not validate the caller, only "currently only the popup calls it" | true | Added a sender whitelist + negative tests |
| The blacklist only governs the current URL, not the effect of the operation; navigate does not validate the target | true | Narrow authorization changed to origin-level delegation: navigate/open are rejected upfront |
| "Invisible means no ref" only holds at the snapshot stage; the execution layer can still find the DOM directly | true (TOCTOU) | Execution layer resolveTarget: visibility + snapshot signature re-check |
| MAIN world eval makes origin isolation ineffective | true | MAIN eval disabled under narrow authorization |
| Any local process can impersonate the extension and connect to /ws; /cmd etc. have no authentication | true | Local control-plane capability token (HTTP + WS) |
| When the port is occupied the native host will relay to "whoever occupies the port" | true, the most severe | Fail closed on token mismatch (refuse to relay and exit) |
| There is no per-tab command queue; snapshotAfter may capture another browser | true | Queue + snapshot pinned to "the browser that took the order" |
| Multiple Profiles of the same browser all report browser: chrome, indistinguishable | true | hello carries instance, supports chrome@<prefix> |
| The hand-written WS parser has no frame length limit and lacks malformed-frame tests | true | 8MB per-frame limit; malformed/oversized frames disconnect |
| background.js + inline PAGE_OP is already maintenance debt | true | **Not done** (splitting requires a build step; for now keep the blocking + extraction tests) |

---

## 1. Review Body
### Submitted Material
dsh-page-bridge-review.zip
File
bundle-full.md
Document
Thought for 3m 20s
### Review Body
I cross-read all the source code, tests and README in bundle-full.md. The conclusion first:

The architecture approach of this project holds up, and the engineering quality is clearly above that of an ordinary personal automation script; but at present several core statements of the "security model" are stronger than the actual implementation. The most critical thing is not the snapshot algorithm, but: the local bridge has no real authentication, the blacklist is not "effect-level" blocking, and the invisibility of refs only holds at the snapshot stage.

On a 10-point scale, I would give:

Project Score Core reason
Security model 5.5/10 The permission layering design is decent, but there are control-plane problems that can be substantially bypassed
Architecture 7.5/10 The three-layer division is reasonable; native/WS has value, but relay is an obvious complexity hotspot
Robustness 7/10 Handling of real Chromium pain points is very solid, but there are TOCTOU, concurrency and target-drift problems
Engineering 7.5/10 Good testing awareness; CI, counterexamples and self-checks are all fairly mature
Maintainability 6.5/10 background.js + inline PAGE_OP + a hand-written protocol is already entering the zone of "I will be afraid to change it myself later"
1. Security model: there are three substantive problems here

1.1 "Full takeover can only be enabled by the user" is currently a "calling convention", not an enforced security boundary

Your current core judgment is:

JavaScript
if (msg?.kind === 'setFullAccess') {
  fullAccess = Boolean(msg.value);
  ...
}

That is, runtime.onMessage does not verify whether the sender is actually the popup. The corresponding code itself only requires the message type to be correct.

And Chrome's message model already allows a service worker to exchange messages with content scripts and other extension contexts; the official documentation explicitly presents runtime.sendMessage() as the standard communication mechanism between different extension contexts.
Chrome for Developers
+1

So the accurate statement now should be:

"In the current project only the popup calls setFullAccess, and the bridge has no such command."

Rather than:

"It can only be called when the user clicks in the popup."

The two have different security meanings.

The bigger problem

You have in effect protected "privilege escalation" on the fact that there is currently no other caller, rather than on a hard condition such as:

Plain text
sender.url === chrome.runtime.getURL("popup.html")

You have already written a dedicated "the Agent cannot escalate its own privileges" test, but what it tests is:

Plain text
bridge → unknown command

This only proves that the bridge cannot escalate privileges; it cannot prove that all non-popup callers inside the extension cannot escalate privileges. The location of the test shows this too.

Suggestion

Change the setter into a real permission boundary:

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

Then add a negative test:

content-script / injected isolated world / extension page → setFullAccess must fail.

Only that truly closes the loop.

2. The blacklist: this is what I consider the most important logic hole at present

The location of your blacklist check itself is fine:

JavaScript
authorizedTab()

Before every command it re-checks the URL of the current tab, and under full takeover it also checks blockDomains.

The problem is that what it checks is "the current target tab", not "the effect produced by this operation".

The most direct example is navigate:

JavaScript
const tab = await chrome.tabs.update(tabId, { url: args.url });

Here args.url is not checked.

Therefore:

Plain text
Current: https://github.com
Blacklist: bank.com
Agent:
page_navigate("https://bank.com")

The flow is actually:

Plain text
authorizedTab()
 ↓
check github.com → allow
 ↓
tabs.update(... bank.com ...)
 ↓
the navigation really happens
 ↓
onUpdated only then discovers the origin changed
 ↓
revoke grant

Your enforceGrantOnNavigation() is a revoke after the fact, not a block beforehand. It does indeed cancel the grant on a cross-origin navigation, and that part is implemented very well, but the navigation itself has already happened.

So what you actually guarantee now is:

"Subsequent agent operations on a blacklisted domain will be rejected."

Rather than:

"The Agent can never make the browser enter a blacklisted domain."

Those are two different levels.

2.1 eval widens this gap further

You provide MAIN-world eval:

JavaScript
return inject(tabId, 'eval', {
  code: args.code,
  worldName: args.world ?? 'MAIN'
}, args.world ?? 'MAIN');

And what actually executes inside PAGE_OP is:

JavaScript
(0, eval)(String(args.code ?? ''))

So even if you fix:

JavaScript
page_navigate("https://bank.com")

the following can still be done:

JavaScript
location.href = "https://bank.com"

Or:

JavaScript
window.open("https://bank.com")

Or construct and submit a form and let the page navigate there itself.

So this is a conceptual problem:

You actually have three different security semantics now
Plain text
Permission boundary
├─ whether you can control this tab
├─ whether you can read this tab
└─ whether you can make the browser produce any side effect

The current code controls the first two layers well, but the third layer is not fully brought into the domain policy.

I suggest you make an explicit choice:

A. The blacklist is only "agent control permission"

Then admit it is not network isolation, and say so clearly in the README.

Or:

B. The blacklist is "the Agent must not make the browser enter these domains"

Then you must bring:

navigate
open
click navigation
form submit
MAIN eval
window.open
navigations triggered by the page itself

all into the same policy model.

The latter is clearly harder, but only then is the semantics complete.

3. "Invisible elements get no ref" is a correct design, but the security guarantee does not carry through to the execution layer

This part of your design is actually very good.

At the snapshot stage:

JavaScript
const visibleHere = vis === 'shown';

if (visibleHere && actionable) {
  ...
  ref = `e${refSeq}`;
}

Invisible elements produce no ref.

And display:contents, the visibility:hidden descendant reversal, details, open shadow root and so on are all taken into account.

I approve of this part.

But later, when you execute a ref:

JavaScript
const byRef = (ref) => deepQuery(`[data-dsh-ref="${ref}"]`);

And then:

JavaScript
const find = ...

The final click is:

JavaScript
const el = find(args.selector);
...
el.click();

With no repeat of:

JavaScript
visible(el)
actionable(el)
the current ref still belongs to the current snapshot

or similar checks.


This means:

Plain text
Snapshot A
  e12 = visible Delete button

The page changes

The element e12 is on:
  hidden
  or its CSS changed
  or its attributes were modified by a page script
  or the DOM was replaced/cloned

Agent → click e12

Your execution layer may still directly find and click [data-dsh-ref="e12"].

An even more dangerous point

data-dsh-ref is a page DOM attribute.

It is state the page itself can change.

So the current ref is more like:

"hanging a model addressing label on the web page DOM"

rather than:

"a trusted object reference owned by the extension itself".

I would change it to

Before execution, uniformly go through:

Plain text
resolveTarget()
 ↓
find the element
 ↓
verify it is still a currently visible composed-tree element
 ↓
verify it is still actionable
 ↓
verify the page/snapshot generation the ref belongs to
 ↓
execute

You could even give the snapshot a generation:

Plain text
snapshot generation = 42
ref = e12@g42

It is not necessarily true that @g42 has to be exposed to the model, but internally it can be checked.

4. A more severe security problem: the identity boundary you built for native messaging is removed again at the bridge layer

This is the one thing I most want you to change in this review.

Chrome's native messaging itself has an identity boundary:

JSON
"allowed_origins": [
  "chrome-extension://..."
]

Chrome officially also states clearly that allowed_origins is used to restrict which extensions can access the native host.
Chrome for Developers

And your registrar does generate it correctly.

But inside the bridge this identity is not maintained further.

4.1 Any local process can connect to /ws

bridge:

JavaScript
server.on('upgrade', ...)

On receiving a WS connection it immediately:

JavaScript
clients.add(client)

Then the client sends by itself:

JavaScript
{
  type: "hello",
  agent: "chrome-extension"
}

And the bridge:

JavaScript
client.label = msg.agent ?? 'unknown';

 

Next:

JavaScript
extensionClient()

Only trusts:

JavaScript
c.label === 'chrome-extension'

combined with focused / lastActive to pick the target.

That is, a malicious process on this machine can perfectly well impersonate an extension client.

It does not even need to touch Chrome.

5. A more specific bypass: when fixed port 8799 is preempted, the native host actively hands messages to whoever occupies the port

This is more severe than "WS has no token".

Your design is:

Plain text
Chrome
 ↓ native messaging
bridge --native
 ↓
discovers 8799 is already occupied
 ↓
startRelay()
 ↓
ws://127.0.0.1:8799/ws

And startRelay():

JavaScript
handshake.on('upgrade', ...)

has no authentication whatsoever.

So the attack path can be:

Plain text
malicious local process
 ↓
binds 127.0.0.1:8799 first
 ↓
Chrome starts the real native host
 ↓
the real bridge: EADDRINUSE
 ↓
enters relay
 ↓
actively connects to the malicious process's WS
 ↓
native hello / cmd / result all pass through the attacker

This would make:

the security advantage brought by native messaging, "only this extension can start me", weakened again by relay.

And EADDRINUSE → relay is explicitly designed behavior, not an occasional bug.

My suggestion is very direct

Do not let the native host unconditionally relay to any WS service occupying 8799.

Of the three options, I lean toward:

Plain text
native host
 ↓
an authenticated local bridge

Rather than:

Plain text
native host
 ↓
"whoever occupies 8799 is who I connect to"

The simplest scheme is to give the local bridge a random capability token.

HTTP:

http
Authorization: Bearer <random-token>

The WS handshake must also know the same token.

Then:

Plain text
127.0.0.1 ≠ trusted

Only with the capability in hand is it trusted.

6. /cmd, /events, /state, /shutdown all have no authentication

Your HTTP layer is:

Plain text
GET /status
GET /events
GET /state
POST /cmd
POST /shutdown

And /cmd directly:

JavaScript
dispatch(body.name, body.args ...)

with no token / session / caller identity.

This means any program on this machine can:

Plain text
GET /events
GET /state
POST /cmd
POST /shutdown

Especially:

Plain text
/events
/state

expose page metadata;

and:

Plain text
/cmd

is the actual control entry point.

So the passage in your README:

"The browser side no longer listens on a port, therefore no token validation is done"

I would suggest changing to:

"The browser side no longer listens on a port, therefore no browser entry token is needed; but the bridge's local control plane still needs authentication."

This is a more accurate security model.

7. The bridge's WebSocket hand-written protocol: zero dependency is worth it, but it has now entered the danger zone

I support your original decision not to use dependencies.

Because one of your core goals is precisely:

Plain text
Native Node runtime
+
no npm runtime dependency introduced
+
simple installation

This goal is reasonable.

But now bridge.mjs already implements by itself:

WebSocket handshake
text frame
masking
64-bit length
control frame
native framing
relay
client routing

The problem is not code length, but the protocol boundary.

The current tests mainly prove:

Plain text
normal frames can round-trip

rather than:

Plain text
malformed frames cannot drag the bridge to death

At present I do not see tests for the following:

Plain text
fragmented frame
continuation frame
RSV bits
oversized 127-length frame
relay outbound frame > 65535
oversized control frame
unmasked client frame
malicious JSON flood
half a header that never ends
a continuously growing receive buffer

And decodeFrames() has no hard limit of its own on frame length.

So there are two acceptable routes here

Route A: continue with zero dependencies

Then isolate the parser and add:

Plain text
protocol-fuzz-test
malformed-frame-test
size-limit-test
fragmentation-test

Route B: allow one runtime dependency

Adopt a mature WS implementation directly.

For a personal internal tool, I do not require you to choose B; but if it is to be published to more users in the future, I would reconsider whether the trade of "zero dependency" for "implementing the protocol yourself" is worth it.

8. The design of PAGE_OP is clever, but it has already begun to become maintenance debt

This function now in effect simultaneously takes on:

Plain text
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

And for testing, you again pull it out and execute it through:

Plain text
#region
 ↓
regex extract
 ↓
new Function(...)

This approach is very practical in the short term, and I do not object to it.

But from a maintenance point of view, it already shows one fact:

background.js is no longer a service worker file, but the entire browser execution engine.

The 1253 lines confirm this too. Your CI does have very good regression tests, but the code structure itself is already close to the point of needing to be split.

I would not refactor right now for the sake of "pretty architecture".

But the next stage should consider:

Plain text
background/
  transport.js
  policy.js
  authorization.js
  tabs.js
  page-op/
    snapshot.js
    actions.js
    refs.js

and then finally generate a single MV3 service-worker file.

9. The Chrome + Edge handling is correct, but your next pit is actually "two Chromes"

You currently:

Plain text
Chrome → browser=chrome
Edge → browser=edge

Plus:

Plain text
focused
lastActive
page_use_browser

This set is reasonable for Chrome+Edge.

Especially, you specifically excluded heartbeat from polluting lastActive; that correction is right.

But there is still one unsolved problem:

Plain text
Chrome Profile A
Chrome Profile B

Both will send:

Plain text
browser = chrome

So:

JavaScript
return list.find((c) => c.browser === browser)

is still not unique.

Likewise:

Plain text
Edge Profile A
Edge Profile B

is the same.

I suggest hello add:
Plain text
browser
profileInstanceId
connectionId

For example:

JSON
{
  "type": "hello",
  "browser": "chrome",
  "instance": "5e3b..."
}

From then on page_use_browser should no longer be merely:

Plain text
chrome
edge

but rather:

Plain text
chrome#5e3b...
edge#8af1...

This would thoroughly solve the problem that "tabId is only unique within a browser, not globally unique on the machine".

10. There is also a very practical concurrency problem: there is no per-tab command queue

This is a robustness problem that I think you have not yet fully considered.

Suppose the following arrive at the same time:

Plain text
page_click A
page_type B
page_snapshot
page_click C

Now onTransportMessage() is:

JavaScript
const result = await handle(...)

Each message is async on its own, and there is no place where one sees a:

Plain text
tab 1 command queue

So the following may happen:

Plain text
click A
 ↓
the page starts a React update

type B
 ↓
snapshot
 ↓
click C

The execution order and the order the model sees are no longer necessarily the same.

Especially your:

Plain text
snapshotAfter()

still asynchronously waits 250/900ms and then looks for the current browser again.

So a very realistic situation arises:

Plain text
T0 action sent to Chrome
T1 the user switches to Edge
T2 snapshotAfter()
T3 snapshot sent to Edge

In the end the model gets:

"the post-click snapshot of GitHub just now"

but it is actually:

the snapshot of Edge's current page

Your page_use_browser can mitigate it, but in the default mode it can still happen.

How to solve it

At a minimum do:

Plain text
session
  └─ browser connection
       └─ tab command queue

and bind one action + snapshot to the same connection.

11. Service Worker handling: the direction is correct, but there are two risks

You handle:

Plain text
20s heartbeat
30s alarm
native probe
WS fallback
retry backoff

This part is very solid.

But:

Risk 1: the native probe is only 900ms
JavaScript
setTimeout(() => {
  if (!sawMessage && nativePort === port) {
    port.disconnect();
  }
}, 900);

On a normal machine that may be entirely enough, but it actually means:

Plain text
no successful handshake within 900ms
→ native judged useless
→ WS fallback

This turns "slow start" into "false failure".

The suggestion is not simply to change it to 5 seconds, but to:

Plain text
CONNECTING
 ↓
HELLO_SENT
 ↓
PROBING 2~3s
 ↓
NATIVE
 ↓
FAILED → WS

make it an explicit state machine.

12. The snapshot algorithm itself: this is the part of the project I approve of most

Here I basically have no major negative opinion.

You did not simply use:

JavaScript
getBoundingClientRect()

as a one-size-fits-all, but distinguish:

Plain text
hidden
flat
shown

This solves:

display: contents
visibility:hidden → child visible
shadow root
<details>
stable ref numbering

These are pitfalls that are very easy to hit in real browser automation.

Especially the counterexamples you made:

Plain text
whether an old ref drifts
whether the old-style key submits
whether an invisible ref enters the snapshot
whether collapsed details content leaks
whether the shadow root can be seen

are far more valuable than simply testing the "normal case". The self-check table does reflect this too.

13. But html and eval mean "invisible content" can still be read out

You designed:

Plain text
the snapshot does not show invisible

very well.

But:

Plain text
page_html
page_eval
page_text

do not share this visibility semantics.

For example html explicitly returns:

JavaScript
document.documentElement.outerHTML

as well as all open shadow roots.

So:

Plain text
"an invisible button gets no ref"

and:

Plain text
"the Agent cannot see invisible content"

are not the same thing.

If you want to define it as interaction safety, fine.

If you want to define it as data-leak safety, at present that does not hold.

14. Test strategy: very good, but there are still obvious blind spots

Your current testing focus is:

Plain text
pitfalls that have actually been hit

This strategy is right.

CI does already cover:

policy
SW state machine
native framing
extension ID
MCP smoke

while the real-browser:

Plain text
snapshot-probe
native-e2e

are explicitly not in CI.

This is not wrong, but it means:

12/12 green does not equal "the whole browser chain is green".

The README already honestly states this limitation, so I will not accuse the CI being green of being misleading.

I would add these 8 tests

Of which the first 5 have the highest priority:

Plain text
1. navigate → blocklisted destination
2. eval("location.href = blocklisted")
3. hidden element → direct CSS selector click
4. stale ref after DOM replacement
5. malicious localhost WS client impersonation
6. port 8799 pre-bind → native relay hijack
7. two Chrome profiles simultaneously
8. concurrent commands on same tab

Especially items 5 and 6: the current test matrix does not cover the real attack model.

15. The event log has a small but real engineering problem

In memory you have:

JavaScript
MAX_EVENTS = 500

which indeed keeps only 500 entries.

But on disk:

JavaScript
appendFileSync(LOG_FILE, ...)

appends without bound.

So:

Plain text
events[] = rolling 500
events.jsonl = unbounded

and the README describes it as a rolling record again.

This is not a security disaster, but it falls under "the implementation semantics and the documentation semantics are not exactly the same".

A better approach:

Plain text
events-YYYYMMDD.jsonl

or rotate once it reaches, say:

Plain text
10 MB

In that way the privacy boundary is clearer too.

16. Portability: your design is basically workable, but users will hit four kinds of pitfalls

The registrar part is on the whole reasonable:

Plain text
%APPDATA%
HKCU
absolute launcher
allowed_origins

and allowed_origins permits only a specific extension ID, which conforms to the design of Chrome native messaging.
Chrome for Developers

Changing directory

This is the biggest one:

Plain text
.
 ↓
.

the unpacked extension ID changes.

You have already explicitly tested this yourself.

So:

Plain text
change directory
→ extension ID changes
→ allowed_origins is stale
→ native stops working

and it must be registered again.

Changing machine

Likewise:

Plain text
user directory
absolute paths
Node path
registry
manifest

may all change.

In particular the launcher directly writes:

cmd
"<current process.execPath>" "<project path>\bridge.mjs" --native

So after upgrading / removing the DSH runtime, this launcher may immediately stop working.

Changing browser

You have handled Chrome / Edge well, because the two registration paths are maintained separately.

But your code also recognizes:

Plain text
brave
opera

while register-host.mjs does not have these two vendors.

So these two will in the end still degrade to WS.

This should be written more visibly in the README:

Plain text
Chrome / Edge = native supported
Brave / Opera = WS fallback
Custom Chromium profile

discoveredIds() only scans:

Plain text
Default
Profile *

That is fine for auxiliary diagnosis, but custom profile names are not within the scan range.

This is not a bug of registration itself, but it may cause:

"the extension is clearly installed, yet the diagnostic script says it was not found."

17. native + WS: I think it is "necessary", but relay is somewhat over-designed

My judgment is:

native + WS

is worth keeping.

Because it solves two different problems:

Plain text
native
→ formal installation / best lifecycle / no browser listening port

WS
→ no registration needed / development / failure fallback

This combination has very real value.

host + relay

I am less certain about.

You currently, for the sake of:

Plain text
the bridge is already running
+
Chrome starts the native host again

designed:

Plain text
native host
 ↓
WS relay
 ↓
the existing bridge

This is indeed very clever.

But the cost it brings happens to be concentrated exactly in the most sensitive places:

Plain text
identity authentication
port hijacking
protocol conversion
double framing
error handling
lifecycle

So my assessment is:

native + WS is an engineering redundancy; native→WS relay is a security complexity.

If in the future you were allowed to delete only one set, I would actually delete relay first, rather than deleting WS.

18. How I would redraw the security boundary

Right now your security boundary is more like:

Plain text
  Chrome
  │
  native messaging
  │
  [has identity verification]
  │
  bridge
  / \
  HTTP   WS
  [no auth] [no auth]
  \ /
  tools

I suggest the goal become:

Plain text
  Chrome
  │
  native messaging
  │
  [extension ID]
  │
  bridge
  ┌──────┴──────┐
  │  capability │
  │     auth    │
  └──────┬──────┘
  │
  router / queue
  │
  ┌─────────┴─────────┐
  │                   │
  MCP / CLI       extension
  │
  authorization policy
  │        │        │
  grant   domain   target

That is:

native messaging is the browser→host authentication.

The capability token is the authentication of the control plane inside the host/bridge.

These two should not be merged into one.

19. If only three things may be changed

My ordering is not "features first", but by security benefit:

First thing: give the bridge control plane real identity authentication, and abolish the unauthenticated relay

This is the first priority.

At a minimum:

Plain text
POST /cmd
GET /events
GET /state
POST /shutdown
WS /ws

must not rely only on:

Plain text
127.0.0.1

to establish trust.

And it must be tested:

Plain text
a malicious process occupies 8799 first
→ native host
→ it should not hand the native traffic to it

This is what I consider the most severe actual attack path at present.

Second thing: upgrade the domain policy from "check the current tab" to "check the effect of the operation"

At the very minimum do this first:

Plain text
navigate(target URL) → check first
open(target URL) → already checked, keep it

Then explicitly handle:

Plain text
MAIN eval
click → navigation
form submit
window.open

If you are not prepared to build a complete "navigation firewall", then change the documentation to:

the blacklist restricts the Agent's further operations on the current page, and does not guarantee preventing the page from performing a network navigation.

This semantics is the most important thing now.

Third thing: make ref / action a one-shot trusted target resolution

Unify:

Plain text
resolve
 ↓
visible?
 ↓
actionable?
 ↓
same target?
 ↓
execute

Do not again:

Plain text
visible at snapshot time
↓
at execution time only look up data-dsh-ref

At the same time do:

Plain text
per-browser
per-tab
command queue

together.

This way you will solve at once:

Plain text
stale ref
hidden ref
Chrome/Edge drift
concurrent actions
snapshot running off to another browser

this whole class of problems.

The final review conclusion

I would not suggest you overturn this project.

On the contrary, I think it has now entered a very clear stage:

Plain text
v0.x:
"can the browser you are using be connected to the Agent?"
 ↓
already solved

now:
"how can this connection form a truly trusted security boundary?"
 ↓
this is the next stage

What is most worth affirming right now is not "many features", but that you have already begun to think about real browser automation with counterexample tests: hidden containers, shadow DOM, React keyCode, MV3 sleep, Chrome/Edge tabId, ref drift — these are not things you run into by casually writing a demo.

But the security boundary now shows, in three places, a case of "the name is stronger than the implementation":

Plain text
"popup-only" → actually "currently only the popup calls it"
"blacklist active" → actually "check the current URL before commands"
"invisible has no ref"
  → actually "there is no ref in the snapshot, but the execution layer can still find the DOM directly"

Once these three places are corrected, and the bridge identity authentication / relay hijacking is added, I would consider its security model to truly deserve the positioning of "really driving the browser the user is logged into".

In addition, Chrome's official native messaging does already provide the allowed_origins layer of origin restriction; your implementation makes correct use of it, but this layer of authentication cannot automatically extend to the localhost HTTP/WS control plane you open yourself.
Chrome for Developers

One-sentence assessment: the architecture does not need to be overturned, the security model needs to be tightened again; what most needs changing is not the snapshot, but the bridge trust boundary.

You have currently used up your attachment quota. Please upgrade your plan to get more quota, or retry after tomorrow 17:19.

---

## 2. Follow-up Questions and Answers on the Semantic Choice

### My Follow-up Questions
Continuing from your review, let me first ask a question I do not want to decide myself (the rest of the P0 items I am already changing: the bridge capability token, the setFullAccess sender whitelist, the execution-layer resolveTarget).

**About blacklist semantics A/B:**

1. Do you suggest **doing A first** (only change the documentation, admitting "the blacklist only constrains the agent's control permission, and does not guarantee preventing the page from performing a network navigation") or **doing B directly** (a navigation firewall)? What is the reason?

2. If you do B, what is the **minimal viable set** you suggest? Among the following channels, which must be blocked first and which can accept "just make it clear in the documentation":
 - page_navigate (my own command)
 - page_open (open a new tab)
 - the navigation caused by page_click clicking a link/button
 - the page's own form submit
 - MAIN world eval (location.href = ...)
 - window.open

3. I thought of a **middle gear**: under narrow authorization (sharing a single tab), navigate only allows **same-origin** targets (SPA routing still works), and cross-origin is rejected outright with the prompt "please share again"; under full takeover mode only the blacklist is checked. Do you think this gear is reasonable? Or is there a less troublesome and yet more rigorous approach?

No need to resend the source code; you have already seen all the code.


### ChatGPT's Answer
My suggestion is: do not do pure A, and do not do "complete B" right now either. The middle gear you proposed is more appropriate, but I would formally define it as:

narrow authorization = origin-bound (the shared tab is bound to an origin)
full takeover = browser-wide control + denylist

This is what I think is the least troublesome scheme at present that is also the easiest to keep semantically correct in the long run.

1. A / B, which to choose?

I choose the middle gear you proposed, not pure A or complete B.

There are two reasons.

First, pure A would make the word "blacklist" more and more easily misunderstood. Right now authorizedTab() does indeed re-check the current URL every time; and the navigation itself is executed only after the current tab is authorized, after which enforceGrantOnNavigation() discovers the cross-origin and revokes the share. That is, it is currently a revoke after the fact, not a block before navigation.


Second, complete B would quickly turn into a "browser network firewall" project. You already have MAIN eval, which can directly execute location.href, window.open, and click may also produce unknown side effects from the page's own JS. PAGE_OP indeed currently allows MAIN eval, and click also directly calls the click() of the page element.

So the real problem of complete B is not whether page_navigate is easy to block, but:

whether you want to promise "the page can never bring the browser into a blacklisted domain".

Once you promise that, you must consider the network layer/navigation layer, not just MCP commands.

2. The formal semantics I suggest

I would define the permission model like this:

Channel Narrow authorization Full takeover
Read/operate the current tab Allowed Allowed
page_navigate same origin Allowed Allowed
page_navigate cross origin Denied Allowed, but denied by blacklist
page_open Suggest allowing same-origin only, or simply require full takeover Allowed, but denied by blacklist
click navigation Allowed, but must not actively treat it as "cross-origin authorization" Allowed, but the blacklist rule still applies
form submit Same as above Same as above
MAIN eval Suggest disabling Allowed
window.open Same as eval Allowed
Blacklisted domains Always denied Always denied

The most critical point here is:

narrow authorization is not "once a tab is shared you can control this tab to go anywhere", but "this origin is shared".

This in fact fits very well with the grant design you have already implemented, because the share record itself already stores:

Plain text
tabId
origin
url
title
grantedAt

and after navigation the existing code compares the current origin with the grant origin.


So you are not starting from scratch, but moving the existing model from "revoke after the fact" forward into "deny beforehand".

3. The six channels, I suggest handling them concretely like this
page_navigate

Must be blocked.

This is the cheapest and highest-benefit one.

Under narrow authorization:

Plain text
target origin === grant.origin
  → allow

target origin !== grant.origin
  → reject immediately
  → prompt "this tab needs to be shared again"

Full takeover:

Plain text
target ∉ blocklist → allow
target ∈ blocklist → deny

I think this one should be at the P0/P1 level.

page_open

Here I suggest being a bit stricter than your original idea:

Under narrow authorization:

only same-origin is allowed, or simply require full takeover.

The reason is that "opening a new tab" is essentially also the agent actively choosing a new browsing target.

The current implementation of open is already:

Plain text
narrow mode:
as long as there is a grant
→ opening any non-blacklisted HTTP URL is allowed

and it itself is not subject to that tabId === grant.tabId restriction of authorizedTab(), because open is a special branch.

This actually means the current narrow mode is not a strict single-origin delegation.

So my recommendation is:

narrow authorization = the target of open must also be the same as the grant origin.

For example, sharing github.com:

Plain text
github.com/...     ✓
api.github.com     ✗
google.com         ✗

rather than relying only on the blacklist.

page_click

Here I do not suggest you do "perfect blocking" from the start.

Because:

JavaScript
el.click()

where it ends up afterwards may be jointly decided by:

<a href>
JS handler
React handler
router
framework middleware

The current implementation just directly triggers the page click.

Minimal viable approach

Allow click, but bring "whether the navigation is cross-origin / enters the blacklist" into the action's post-check.

That is:

Plain text
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

This way:

Plain text
the Agent cannot obtain long-term control of a new origin through click.

But I want to be explicit:

this is not "absolutely prevent the browser from issuing the first request", but "revoke the cross-origin delegation immediately after the click".

If later you decide the definition of B is "a blacklisted domain must never produce a network request", only then is it necessary to upgrade to real network/navigation-layer interception.

The page's own form submit

Handle at the same level as click.

I would not introduce a complex browser navigation firewall for it now.

Do:

Plain text
submit
→ wait a short while
→ check the final origin
→ narrow mode cross-origin → revoke
→ blacklist → revoke

and it is enough.

The reason is that form submission likewise has a great many cases of "the page itself deciding the destination".

4. MAIN eval is the only one I think must be treated differently

Here I will be very explicit:

under narrow authorization, disable MAIN eval

Because right now:

JavaScript
(0, eval)(String(args.code ?? ''))

it is not "a navigation API", but arbitrary JS capability.

So if under narrow authorization you allow:

JavaScript
location.href = ...

then the so-called:

"narrow mode can only operate on this origin"

immediately becomes ineffective.

You can of course say:

eval is an advanced escape hatch, and the user bears the risk themselves.

Then it should be explicitly turned into an independent permission:

Plain text
narrow mode
├─ DOM read/write ✓
├─ same-origin nav ✓
└─ MAIN eval ✗

full takeover
└─ MAIN eval ✓

I think this is far more rigorous than trying to "parse the eval string and see whether it is a navigation".

Because:

JavaScript
location.href = foo()

and:

JavaScript
window[method](...)

this kind of thing simply does not need to be chased any further.

5. window.open

Just follow eval's rule directly.

That is:

narrow authorization:
Plain text
MAIN eval → forbidden

so naturally there is no:

Plain text
eval → window.open()

escape hatch.

Full takeover:

allowed, but the target URL goes through the blocklist policy.

So you do not need to design yet another separate permission model for window.open.

6. This way, what you actually get is a very clean three-level model

I would define it as:

Plain text
Level 0
not shared
→ cannot read/operate the page

Level 1
share an origin
→ can only operate on this origin
→ cannot MAIN eval
→ cannot actively cross-origin open/navigate
→ click/form may cause the page to navigate on its own, but once it is cross-origin, the authorization is revoked immediately

Level 2
full takeover
→ any tab / any origin
→ but the blocklist is always in effect
→ MAIN eval is open

The biggest advantage of this model is:

the permission semantics are extremely easy to explain.

The user only needs to remember:

"share = hand this website to the Agent."
"full takeover = hand the whole browser to the Agent."
"blacklist = domains that even full takeover cannot touch."

This is much clearer than "the blacklist is simultaneously a network firewall, a navigation firewall, a permission firewall, and a page content filter".

7. So when is it worth actually doing complete B?

I suggest not for the time being.

Only when in the future you really need this promise:

"no matter by what means the Agent uses, a blacklisted domain cannot have a top-level navigation/network access."

is it worth introducing a second layer of real browser network policy.

At that time you could consider:

Plain text
Agent command policy
+
browser navigation policy
+
network request policy

and even unify the denylist into browser-level rules.

But that is no longer a "small fix" of your current Page Bridge, but a security model upgrade.

Final decision

So I will make the call for you:

do not choose A now, and do not go with complete B either.

Directly do the middle gear you proposed, but tighten it slightly into:

narrow authorization is isolated by origin; full takeover is isolated by denylist.

Concretely:

must be blocked first:

Plain text
page_navigate
page_open (at least same origin in narrow mode)
MAIN eval (simply disable it in narrow mode)

allow post-checks:

Plain text
page_click
form submit

window.open is not handled separately:

Plain text
narrow mode: disabled together with MAIN eval
full takeover: opened together with eval, but subject to the denylist

This way you do not suddenly turn the project into a "browser network firewall", and yet you can truly upgrade "sharing one tab" into a trusted origin-scoped capability.

And this scheme connects directly with the code structure you already have — grant.origin, automatic cross-origin revoke, and continuing to check the blocklist under full takeover — and does not require overturning the existing architecture.
