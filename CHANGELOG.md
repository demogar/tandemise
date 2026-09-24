# Changelog

## [0.4.0](https://github.com/demogar/tandemise/compare/v0.3.1...v0.4.0) (2026-09-16)


### Features

* focus the team on you + your agents, and plan P3 outside contributions ([75245c2](https://github.com/demogar/tandemise/commit/75245c268154eedea4532c878961c263f7c9f31a))

## [0.3.1](https://github.com/demogar/tandemise/compare/v0.3.0...v0.3.1) (2026-09-16)


### Bug Fixes

* a completion gate reads the current state, not every measurement ever taken ([a2a64d4](https://github.com/demogar/tandemise/commit/a2a64d43dbdc533090faeb5194be81d1d5f761ab))

## [0.3.0](https://github.com/demogar/tandemise/compare/v0.2.0...v0.3.0) (2026-09-15)


### Features

* feedback rounds, a handoff feed, and a responsible person behind every task ([4e5e96f](https://github.com/demogar/tandemise/commit/4e5e96fb288a0e914e560731a6461b82789d3305))

## [0.2.0](https://github.com/demogar/tandemise/compare/v0.1.0...v0.2.0) (2026-09-13)


### Features

* a mission may span a project's repositories ([d1dec9b](https://github.com/demogar/tandemise/commit/d1dec9b43fa1a018776ccdc04d3ba81edc920ea7))
* **api,roles:** daemon API contract, built-in roles, workflow presets ([4967943](https://github.com/demogar/tandemise/commit/4967943c071b8b485c6da1db89e49c0cb5391312))
* **api:** let the user declare a runtime's capabilities; document limitations ([d35faac](https://github.com/demogar/tandemise/commit/d35faac12446b9c2a0be6bf206a1b43669bf8acf))
* **application:** mission engine complete; whole monorepo builds ([9ef1f9b](https://github.com/demogar/tandemise/commit/9ef1f9b1ed28218035935c575f2125f21e7bc29f))
* **application:** service facade definition ([a67c2fc](https://github.com/demogar/tandemise/commit/a67c2fc16c57a52f30d30e1a86b6b5a35793fcb1))
* **approvals:** accept a result whose gate cannot be met ([e69a501](https://github.com/demogar/tandemise/commit/e69a501a904aa35717317e9e3a6b560ecc9a9d52))
* **approvals:** allow a tool for the rest of a task; trust a server's read-only labels ([28696e4](https://github.com/demogar/tandemise/commit/28696e43260ba764e03c098752f06df4a6d89510))
* compose the run-scoped MCP gateway so workers can invoke tools ([ac1be13](https://github.com/demogar/tandemise/commit/ac1be1374eab088ee2278d0e1ff02f9aca3e79fa))
* **core:** shared, kernel, and domain contracts ([e9deaa1](https://github.com/demogar/tandemise/commit/e9deaa1419b180f832913328c0e86dff0a5fa019))
* **daemon:** bind platform ports in the composition root ([1a40609](https://github.com/demogar/tandemise/commit/1a40609595e2771188221c52e70a45d19adeafbb))
* **daemon:** composition root, buses, entry point ([3ec516a](https://github.com/demogar/tandemise/commit/3ec516a59d7bde140ab526ef055ed0a4b8816de2))
* **daemon:** coordinated shutdown handling ([f8405ce](https://github.com/demogar/tandemise/commit/f8405cedf61e58c308c6b3e9f94323ba776080fa))
* **daemon:** HTTP transport, auth, instance lock, event stream ([6fe4bdf](https://github.com/demogar/tandemise/commit/6fe4bdfeeb90c787391c9e6849a3d0a97a6cac79))
* **daemon:** macOS Keychain secret store ([8d2d16e](https://github.com/demogar/tandemise/commit/8d2d16eb276ad6d48a10034951b749137a5c0fc6))
* **daemon:** route table and config ([51649b0](https://github.com/demogar/tandemise/commit/51649b099769ec48795336f1fb2507dfe79df494))
* **desktop:** brand palette as an enforced design system, with a matching logo ([83d79b7](https://github.com/demogar/tandemise/commit/83d79b76f3520cc91dd63143529f6c68f808f303))
* **desktop:** every mission, task, plan, approval, run and artifact shows its id ([2ba3f48](https://github.com/demogar/tandemise/commit/2ba3f483135d471601f08de3f8af264d8e05c92a))
* **desktop:** give the app its own name and mark ([1e0de77](https://github.com/demogar/tandemise/commit/1e0de7772394273c96ac22a18cee3a09d1c74a6b))
* **desktop:** projects, and a way to be in one ([b12a35c](https://github.com/demogar/tandemise/commit/b12a35c093017a4dafa1c072a78e90874268e237))
* everything belongs to a project ([55855c8](https://github.com/demogar/tandemise/commit/55855c86f1bcda8a716e68b974fb439963376758))
* **integrations:** add an MCP server that runs as a local command ([c20da55](https://github.com/demogar/tandemise/commit/c20da55f4859aa51efa206c8c506df2c9bbdf632))
* **integrations:** connect apps by signing in, the way OAuth apps work ([03118ae](https://github.com/demogar/tandemise/commit/03118ae58f1d14db5aabb9c92b264a842de62472))
* **integrations:** speak MCP as a client, so any server is an integration ([23fa731](https://github.com/demogar/tandemise/commit/23fa7319a5af3bee03f4d5f4ec42b294abf2967a))
* **integrations:** tool broker, run-scoped MCP gateway, GitHub, browser ([93a4d34](https://github.com/demogar/tandemise/commit/93a4d3430f5cfbb19f9e4db3b20a2a23d4ecab0f))
* **loops:** workers ask you questions, and your feedback becomes the revision ([50efe95](https://github.com/demogar/tandemise/commit/50efe95945d57555668eeae3f90edda90eeeacc4))
* persistence, policy, artifacts, context, evaluation verified ([0b2e326](https://github.com/demogar/tandemise/commit/0b2e32668bc4d465e75024eec1c8150a4680016e))
* **planning:** a task using an asynchronous app waits for its result ([794e24c](https://github.com/demogar/tandemise/commit/794e24cbbbd4071fa269e78d8c1101f07987f024))
* **planning:** planner prompt and plan extraction ([21e0ccd](https://github.com/demogar/tandemise/commit/21e0ccdf6234cfebecc67b02b6b4f98ab3188540))
* **planning:** the planner knows which apps are connected ([fe641ff](https://github.com/demogar/tandemise/commit/fe641ff251fdedc28010327cb13594805a0afb24))
* run a workflow from the app, and wait on the world outside ([f6c3731](https://github.com/demogar/tandemise/commit/f6c37318efdfe7219b27b139c09ed81abdce2f44))
* runtime adapters, execution layer, policy, persistence, artifacts, context ([d855728](https://github.com/demogar/tandemise/commit/d855728d1a34ee56bc52ec1f0ef7e249703e305f))
* **runtime-codex:** Codex CLI adapter ([e9a1f91](https://github.com/demogar/tandemise/commit/e9a1f911cebaf6ec0fa869ab3230f62ec58afc5d))
* **runtimes:** per-profile config directory, and a settings form that adapters define ([f7112ab](https://github.com/demogar/tandemise/commit/f7112ab97ac7281c52361b5ef01a6c71fbb2fcc0))
* **tasks:** retry a task with more access ([cc3ccc2](https://github.com/demogar/tandemise/commit/cc3ccc2c5dbdacfc3b15dbbd5a86285e655d78b9))
* workflows a team writes, and steps a person does ([43a1352](https://github.com/demogar/tandemise/commit/43a1352123daaa9b6e554be3a1c4f57a31ee9a16))


### Bug Fixes

* **application:** give reviewers and testers the actual change ([66206ca](https://github.com/demogar/tandemise/commit/66206caa20ba9314fcec8396889dbfbe88951abc))
* **approvals:** 'Retry once more' on an exhausted task did nothing ([1ba6262](https://github.com/demogar/tandemise/commit/1ba62627e3b916dd2678aa8117e32ebf1d717dfb))
* **artifacts:** a decision record following its own template was refused ([423a469](https://github.com/demogar/tandemise/commit/423a469b19c7211e763cb1f13e1c60237014754a))
* **artifacts:** parallel research silently replaced each other's briefs ([1372792](https://github.com/demogar/tandemise/commit/1372792be1bbdfdc5880664cf9c57eba22f68f8c))
* **build:** tighten boundary import detection; declare kernel in browser and github ([5c2bb09](https://github.com/demogar/tandemise/commit/5c2bb09059a2c3a324b50876293bd7f3008fe3b9))
* **daemon:** connected MCP servers published no tools after a restart ([2dcfee9](https://github.com/demogar/tandemise/commit/2dcfee95077630dbbe181e359edba0ab07b04c4a))
* **daemon:** let the desktop renderer read its responses ([ec4791d](https://github.com/demogar/tandemise/commit/ec4791db46926514b45d9e9efbde366fab881d82))
* **daemon:** Plan mission never left the form ([76407ed](https://github.com/demogar/tandemise/commit/76407ed5ffc07277829f5a827b26229b56d9480f))
* **daemon:** seed a workspace on first start ([69ac2ed](https://github.com/demogar/tandemise/commit/69ac2ed95f02c3650a52b948b43e7d98de43d296))
* **daemon:** start the scheduler, and bind execution-core's own tokens ([58bb64b](https://github.com/demogar/tandemise/commit/58bb64b60fbfa7dddb23bf8a630df571b306575b))
* **daemon:** stop requiring a workspace the desktop has not chosen yet ([f8d8e95](https://github.com/demogar/tandemise/commit/f8d8e95544039f88696374f807bdd118805af34c))
* **desktop:** survive a daemon of a different vintage, and stop selecting chrome ([f398b1e](https://github.com/demogar/tandemise/commit/f398b1ecf3a624cd360a630e212614143ccd5238))
* **desktop:** the approval card blanked the app with a value import from domain ([7dc90b2](https://github.com/demogar/tandemise/commit/7dc90b2e9edd2b637ec9aa88eeb239c1deb84a97))
* **engine:** a forgotten session no longer strands a task ([7b467c9](https://github.com/demogar/tandemise/commit/7b467c997a21eb670fa6c84bffd3dcde32ec4c58))
* **engine:** a forgotten session no longer strands a task ([4bffc38](https://github.com/demogar/tandemise/commit/4bffc38a36298e66b3322f6205dd95542cb70440))
* **execution:** concurrent mkdirs in a shared checkout no longer fail with EEXIST ([84ca685](https://github.com/demogar/tandemise/commit/84ca685c4aedf8ee3287f6c7c304dcc7b8ffe74a))
* **execution:** prevent worktree collisions and unsafe detached-HEAD reuse ([ead93ba](https://github.com/demogar/tandemise/commit/ead93ba7d557a1f99a4043c86653c751168c5837))
* **executor:** a restart spent the task's retry budget ([e98b79d](https://github.com/demogar/tandemise/commit/e98b79d70aa9c1a90d6faace9077ac5295e1f05f))
* **executor:** a resumed run collided with the attempt it continues ([ede4482](https://github.com/demogar/tandemise/commit/ede44823a75a28038e44f6631be6ec62411ebe48))
* **executor:** a task could push its branch but never open its pull request ([0315685](https://github.com/demogar/tandemise/commit/03156859fc28607c102d1b5c1180ccc5ffac4475))
* **executor:** an evaluator that found problems was re-run instead of fixed ([9659628](https://github.com/demogar/tandemise/commit/9659628131723d034374d42b4c06ac4237662740))
* **executor:** stopping a run to retry it cancelled the retry ([7a2ed6d](https://github.com/demogar/tandemise/commit/7a2ed6d191f88a19f060334f9a15ab00b5c5f7d3))
* **git:** end option parsing before caller-supplied refs ([fa1cd11](https://github.com/demogar/tandemise/commit/fa1cd11ecd414cef36eeabe12499daa70a329e64))
* **github:** checks.list failed on every call with older gh ([bb0e5ae](https://github.com/demogar/tandemise/commit/bb0e5aedcffaec8fde81211646d69a8287094abf))
* keep the desktop icon sources out of the build ignore ([d657109](https://github.com/demogar/tandemise/commit/d65710915e6934a100ba0b5b15197167ae172490))
* **missions:** retrying a task left its dependents running on the old result ([2e40f78](https://github.com/demogar/tandemise/commit/2e40f78397806f3f3eedf061240f02f23e934fb6))
* **missions:** skipping a task left its approval cards open ([df374a2](https://github.com/demogar/tandemise/commit/df374a28b31a59bb6c1f2f8e6090bac912387c39))
* nine defects from the persistence/daemon review ([6e993ed](https://github.com/demogar/tandemise/commit/6e993ed3733c859b848407c26f38121e5696b024))
* **persistence:** let a task actually record that it is parked ([d9b8736](https://github.com/demogar/tandemise/commit/d9b873630aed78e39cf673914013dcab760355be))
* **planning:** a detailed plan was cut off and thrown away ([22cc612](https://github.com/demogar/tandemise/commit/22cc612e778ebd5925808c6ebe5fd700077d0fe9))
* **policy:** a connected-app grant covered no app ([065d543](https://github.com/demogar/tandemise/commit/065d543b45af3dbff3b4a8ec5634206c348a3f28))
* **policy:** close three fail-open paths in the permission engine ([fe0f32c](https://github.com/demogar/tandemise/commit/fe0f32c73144350c083eba8460ab6e2fc123efe6))
* **policy:** gate the default external-writes dial on plan approval ([d8442ef](https://github.com/demogar/tandemise/commit/d8442ef7e9cca9657a8098ed4ed4afb7e600f6cb))
* **policy:** neutralize fence sentinels in labels, not only bodies ([7ecbb83](https://github.com/demogar/tandemise/commit/7ecbb8341fa90331c72d2153676dc42929551dde))
* **recovery:** a task could be stranded RUNNING with nothing running ([e45b26c](https://github.com/demogar/tandemise/commit/e45b26cbc20b3c0bd55a5aa9e13160915a573f3f))
* **recovery:** reopen a completed mission that still has work queued ([33b0820](https://github.com/demogar/tandemise/commit/33b0820dc3b346451057f4c4512076408216b444))
* **roles:** projects seeded before the timestamp fix still upgrade ([539d7de](https://github.com/demogar/tandemise/commit/539d7de743c36b308b5b5964020e36153616bef6))
* **roles:** shipped role upgrades never reached an existing install ([8f5eadc](https://github.com/demogar/tandemise/commit/8f5eadcfd06ba2bba340f30a07f961cb20cc5d9c))
* **runtime-claude:** no worker could call a connected app's tools ([1e67d9e](https://github.com/demogar/tandemise/commit/1e67d9e03abe089148b6b3b4847bf95574e27dad))
* **runtime-claude:** workers ran the user's personal hooks, plugins and skills ([ddfda4f](https://github.com/demogar/tandemise/commit/ddfda4fd60dd4c1a03f9b3b1c9643c66985fe6fa))
* **runtime:** a signed-out runtime makes work wait instead of blocking it ([9576607](https://github.com/demogar/tandemise/commit/9576607bb8745accade08247e0413b6efc87c172))
* **runtimes:** claim the concurrency slot at start, not on first read ([def82a5](https://github.com/demogar/tandemise/commit/def82a5c00632c81303d98b3005e7c71fac03733))
* **runtimes:** MultiEdit file changes, relative path probing, line recovery ([ef1b5f9](https://github.com/demogar/tandemise/commit/ef1b5f9d8da9ca1348b639034b7f13d3ceda3592))
* **runtimes:** withhold unrelated credentials from worker processes ([842f3c6](https://github.com/demogar/tandemise/commit/842f3c68413f8208894d61e4764d446019e56b0b))
* **scheduler:** a mission with a cancelled task was marked complete ([00b622c](https://github.com/demogar/tandemise/commit/00b622ca82c8ced2a6c17086e96597dcf02f4ec4))
* **scheduler:** restarting the daemon cancelled the work it was doing ([37a4afc](https://github.com/demogar/tandemise/commit/37a4afce0f71a009563784d313251d57cd70fa60))
* **scheduler:** retrying a dead task left its dependents blocked forever ([349ddd9](https://github.com/demogar/tandemise/commit/349ddd96cc3ea6229a49517746e02b57831c89cf))
* schemaless artifacts could never pass, and waiting looked like stuck ([2f06530](https://github.com/demogar/tandemise/commit/2f06530d66352fb6fec2b5cf713cc1b1b8d441cd))
* **security:** close symlink sandbox escape in ScopedFileSystem ([743a946](https://github.com/demogar/tandemise/commit/743a946241a87ba86e2b9e0e23b0cb730aaba243))
* **security:** workers inherited the user's own MCP servers ([97cfdde](https://github.com/demogar/tandemise/commit/97cfddefdc995d370ff65b2d0c5e4613d55f92a8))
* what running real missions through the app broke ([134e758](https://github.com/demogar/tandemise/commit/134e75884c49ce05fa6b6877a8e1b04a1cb99234))
* **workflows:** a step inherits its role's isolation ([dbb0889](https://github.com/demogar/tandemise/commit/dbb0889c0ef0b96c78725ebcc3328a1cdc98d514))


### Performance

* **execution:** seed installed dependencies into fresh worktrees ([4eb2776](https://github.com/demogar/tandemise/commit/4eb2776b5549d42cad0e8505121a4275d9e8786a))
* **scheduler:** read-only tasks in one checkout no longer take turns ([d178778](https://github.com/demogar/tandemise/commit/d178778649051524135c6075a5a4a53bfad6cc21))


### Refactoring

* **domain:** drop unused parameter in gate failure explanation ([a4724ae](https://github.com/demogar/tandemise/commit/a4724ae7487b750da4e1db8bc32a87159ddad0d6))
* **roles:** code-host grants in their own table; seeded roles read as unedited ([3658034](https://github.com/demogar/tandemise/commit/3658034cd36032a6d02dbb91114dca4a2cb2cc8e))


### Documentation

* acceptance criteria evidence tracker ([48f88ca](https://github.com/demogar/tandemise/commit/48f88ca468dad5164c7273ad47e72517d797eb12))
* application layer design ([b3ba168](https://github.com/demogar/tandemise/commit/b3ba1686c9f7263c9c521ba038dc0f3eaec8ad27))
* architecture decision records ([33c6ba8](https://github.com/demogar/tandemise/commit/33c6ba8c24ea14cae1a763d0a784823ac7011473))
* final acceptance record ([4772c73](https://github.com/demogar/tandemise/commit/4772c730818e3b92d38133d05b7ef860aca246a7))
* quickstart ([fb390bf](https://github.com/demogar/tandemise/commit/fb390bf6c1fa69010073b911533892a99e72fe05))
* README ([a2b9995](https://github.com/demogar/tandemise/commit/a2b9995c427bb802ad6d619c90a169ef73ada706))
* record the acceptance criteria now demonstrated end to end ([cec46c0](https://github.com/demogar/tandemise/commit/cec46c0442c3f4e7b5c96868c357d1dd522c3d8c))
* record the second review pass ([12105f1](https://github.com/demogar/tandemise/commit/12105f109d7c2e8f47d8502444cb92253702273f))
* record verified acceptance criteria ([261508b](https://github.com/demogar/tandemise/commit/261508bcd1ccf8e6b1640928378f0fe327eda69c))
* record verified criteria and the security fixes from review ([e20218d](https://github.com/demogar/tandemise/commit/e20218d19215858dd5f83e285dcb962a2fa40792))
