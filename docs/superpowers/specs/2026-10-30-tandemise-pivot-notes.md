# Giro de Tandemise: notas

> Borrador abierto el 2026-10-30. Escríbelo como te salga; no hace falta orden ni formato.
> Las secciones de abajo son solo puntos de partida: borra, añade o ignora las que quieras.

## La idea en una frase

La idea principal es que Tandemise permita a equipos, personas/individuos y
organizaciones completas a completar trabajo de manera más rápida y eficiente.

Que este trabajo no solamente sea de código, pero que a grandes rasgos sea el
primer uso dirigido: una fábrica de software.

## Por qué ahora: qué no te funciona hoy de Tandemise

Realmente ni yo mismo lo estoy utilizando y siempre vuelvo a utilizar claude code
directamente.  Mayormente porque es más rápido y más sencillo.  Lo que me gustaría
es poder tener todo en tandemise.

Digamos que voy a crear un nuevo proyecto, Garipass y agrego todos los
repositorios:
- /garipass/garipass
- /garipass/claude
- /garipass/ops

Luego conecto los MCP y los servicios que estoy utilizando:
- Github
- 1Password
- Docker
- YouTrack
- Buzz / Slack / Discord
- Figma
- Claude Design
- Open Design
- Supabase
- Cualquier otra vaina que sea posible,

Y el sistema pueda determinar directamente varios flujos que puedan utilizar.

## Un día normal con la nueva Tandemise

1. Abro Tandemise
2. Analizo el board y veo que puedo trabajar.  Si no hay nada, puedo pedirle
que sincronice con YouTrack, Sentry, PostHog, GitHub, lo que sea que esté conectado
y que funcione para buscar qué hacer.
3. Selecciono una tarea y la arranco.
4. El sistema de forma totalmente autónoma lleva la tarea desde la idea hasta
tenerla en un PR y automáticamente determina los pasos siguientes: si puede
mergearla completamente o si necesita que alguien la revise en ese momento.

Lo importante tambien es ver quiénes están trabajando en otras cosas, que se ha
hecho anteriormente, saber si hay algo que necesita mi atención.  Y este board
siempre está conectado en todas las líneas.

Este board es el single source of truth y está en algún lado que podemos todos
consumir y acceder pero a través de Tandemise (por lo que quizás necesitemos
un Tandemise server o relay o lo que sea, donde todos se conectan y bajan todo).

Los procesos siempre se pueden tweakear, pero el sistema debe ser lo más inteligente
para determinar:
- los pasos que se requieren
- los skills se requieren por paso
- los modelos que se requieren implementar en cada uno de esos pasos
- qué pasos requieren una validación o aprobación humana

Entre muchas otras cosas

## Qué tomar de las referencias
- **Paperclip:**
- **super-board:**
- **Warp: la "software factory":**

## Lo que NO debe ser
- Un sistema de mensajeria, ni nada similar.  Esto es para que incluso un Product
Manager pueda desarrollar funcionalidades.

## Interfaz: migración a mola-ui
- Por ahora, ignora esto


## Dudas abiertas

## Decisions from the conversation (2026-10-30)

Gathered during the brainstorming session. Not an approved design yet.

**Why it isn't used today.**
- The process is rigid.
- You can't tell what it's doing.
- It doesn't learn from corrections.
- You can't iterate the way you can in Claude Code.

**Distribution.**
- Open source.
- Each team self-hosts its own instance. It is not multi-tenant SaaS.

**Execution.**
- Everything runs on each person's machine, with their own subscriptions and environment.
- The server is optional and very thin. It only stores "dumb" data:
  - who is working on what
  - access
  - a mailbox for webhooks
- Without a server, the same data lives in a local DB with the same shape, so it can be moved later.

**Brain.**
- It lives in its own git repo, one per project. A project can span several repos.
- It holds memory: lessons, conventions, decisions, history.
- It also holds the factory definition: steps, skills, models, gates and MCPs.
- Improvements the factory proposes to itself arrive as PRs to that repo.
- Personal data and secrets stay out.

**Board.**
- There is one board per project: the primary tracker, for example YouTrack.
- Other sources (GitHub, Sentry, PostHog, Slack, Discord, WhatsApp…) come in through an agnostic contract and runners. Tandemise ships some runners; anything else, people connect themselves.
- Tandemise creates or links the task in the primary tracker without duplicating it.
- When the task is done, it closes the loop at the source.

**Starting work.**
- Everything that comes in is recorded, but nothing starts until someone starts it.
- No methodology is imposed: scrum, XP, kanban or none.

**Iterating.**
- "Hold and interact" at any point in the process, using the real Claude Code terminal inside Tandemise.
- When you tell it to continue, the autonomous flow resumes.
- What you correct during the hold feeds the brain.

**Where it can stand out.** Research across about 30 systems found nobody doing these well:
- inferring steps, models and gates
- deciding merges by risk
- a single brain for people and agents
- intake from several sources
- a board a PM can use

**Proposed order (to be confirmed).**
1. Engine with live sessions
2. Brain repo
3. Intake and primary tracker
4. Smart planner and risk-based merge
5. Optional server
6. mola-ui (parked)
