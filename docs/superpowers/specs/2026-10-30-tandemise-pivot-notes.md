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

## Decisiones de la conversación (2026-10-30)

Recogidas durante la sesión de brainstorming. Todavía no son un diseño aprobado.

**Por qué no se usa hoy.**
- El proceso es rígido.
- No se entiende qué está haciendo.
- No aprende de las correcciones.
- No se puede iterar como en Claude Code.

**Distribución.**
- Open source.
- Cada equipo levanta su propia instancia. No es SaaS multi-cliente.

**Ejecución.**
- Todo corre en la máquina de cada persona, con sus suscripciones y su entorno.
- El servidor es opcional y muy ligero. Solo guarda datos "tontos":
  - quién trabaja en qué
  - accesos
  - un buzón para webhooks
- Sin servidor, esos datos viven en una DB local con la misma forma, para poder mudarlos después.

**Cerebro.**
- Vive en su propio repo git, uno por proyecto. Un proyecto puede tener varios repos.
- Contiene la memoria (lecciones, convenciones, decisiones, historial).
- Contiene también la definición de la fábrica: pasos, skills, modelos, gates y MCPs.
- Las mejoras que la fábrica propone sobre sí misma llegan como PR a ese repo.
- Lo personal y los secretos quedan fuera.

**Board.**
- Hay un solo board por proyecto: el tracker principal (por ejemplo YouTrack).
- Las demás fuentes (GitHub, Sentry, PostHog, Slack, Discord, WhatsApp…) entran por un contrato agnóstico, a través de runners. Tandemise trae algunos; para el resto, cada uno conecta el suyo.
- Tandemise crea o enlaza la tarea en el tracker principal, sin duplicar.
- Cuando la tarea termina, cierra el ciclo en el origen.

**Arranque.**
- Todo lo que entra queda registrado, pero nada empieza hasta que alguien lo inicia.
- No se impone metodología: scrum, XP, kanban o ninguna.

**Iterar.**
- "Pausar e interactuar" en cualquier punto del proceso, con la terminal real de Claude Code dentro de Tandemise.
- Cuando le dices que continúe, retoma el flujo autónomo.
- Lo que se corrige en la pausa alimenta el cerebro.

**Lo que puede diferenciarlo** (según la investigación de unos 30 sistemas):
- deducir pasos, modelos y gates
- decidir el merge según el riesgo
- un cerebro único para personas y agentes
- entrada desde varias fuentes
- un board que un PM pueda usar

**Orden propuesto (pendiente de confirmar).**
1. Motor con sesiones vivas
2. Repo cerebro
3. Entrada y tracker principal
4. Planificador inteligente y merge según el riesgo
5. Servidor opcional
6. mola-ui (aparcado)
