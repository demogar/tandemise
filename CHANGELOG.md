# Changelog

## [0.4.0](https://github.com/demogar/tandemise/compare/v0.3.1...v0.4.0) (2026-09-16)


### Features

* focus the team on you + your agents, and plan P3 outside contributions ([#18](https://github.com/demogar/tandemise/issues/18)) ([c8f0149](https://github.com/demogar/tandemise/commit/c8f014998a206c46f49354d332bd871cdcc4a497))

## [0.3.1](https://github.com/demogar/tandemise/compare/v0.3.0...v0.3.1) (2026-09-16)


### Bug Fixes

* a completion gate reads the current state, not every measurement ever taken ([#16](https://github.com/demogar/tandemise/issues/16)) ([ea4626c](https://github.com/demogar/tandemise/commit/ea4626c72a429f815bbfab5e055328d6cb79e1fb))

## [0.3.0](https://github.com/demogar/tandemise/compare/v0.2.0...v0.3.0) (2026-09-15)


### Features

* feedback rounds, a handoff feed, and a responsible person behind every task ([#14](https://github.com/demogar/tandemise/issues/14)) ([7e98629](https://github.com/demogar/tandemise/commit/7e986292b750f22203e0f48ac53448094094c867))

## [0.2.0](https://github.com/demogar/tandemise/compare/v0.1.0...v0.2.0) (2026-09-13)


### Features

* a mission may span a project's repositories ([c62bc83](https://github.com/demogar/tandemise/commit/c62bc83a8940914b05e9449c90fc7020560354da))
* **api,roles:** daemon API contract, built-in roles, workflow presets ([7db8587](https://github.com/demogar/tandemise/commit/7db858728650a331db35d4e914b905aa991b8ce5))
* **api:** let the user declare a runtime's capabilities; document limitations ([b5b15a1](https://github.com/demogar/tandemise/commit/b5b15a154740aaaa693acdcde47438f3f72467e4))
* **application:** mission engine complete; whole monorepo builds ([43dbe17](https://github.com/demogar/tandemise/commit/43dbe17854a72fa5c936ccb3c5d9a7de873f9fcb))
* **application:** service facade definition ([9746e61](https://github.com/demogar/tandemise/commit/9746e6191163ee13552002ded32720c4b2364099))
* **approvals:** accept a result whose gate cannot be met ([87dba59](https://github.com/demogar/tandemise/commit/87dba59452406a20cd06562ac13c8e0afbca3fd2))
* **approvals:** allow a tool for the rest of a task; trust a server's read-only labels ([15fec66](https://github.com/demogar/tandemise/commit/15fec66639a58b1439e2d755e2cdb0b318ce5102))
* compose the run-scoped MCP gateway so workers can invoke tools ([7349f35](https://github.com/demogar/tandemise/commit/7349f3578fa28a628b1edf0bb8c1e728729f25dd))
* **core:** shared, kernel, and domain contracts ([24a17a4](https://github.com/demogar/tandemise/commit/24a17a4dd94d27376b0cc57b49822eb503862eef))
* **daemon:** bind platform ports in the composition root ([567ab4e](https://github.com/demogar/tandemise/commit/567ab4edbdf9dccd4b83d99951481dd6ba0e04a3))
* **daemon:** composition root, buses, entry point ([cee8521](https://github.com/demogar/tandemise/commit/cee85216f956b09765f34f9c284f23150cfa7de6))
* **daemon:** coordinated shutdown handling ([912b001](https://github.com/demogar/tandemise/commit/912b0016744107dd488f4f105ab710cb69fb3168))
* **daemon:** HTTP transport, auth, instance lock, event stream ([9d266bf](https://github.com/demogar/tandemise/commit/9d266bfd6e8586f7e6c727c21997402e52b54962))
* **daemon:** macOS Keychain secret store ([c8cd447](https://github.com/demogar/tandemise/commit/c8cd447a9c31068f8501fc9279bbfa5dc6b71e3b))
* **daemon:** route table and config ([e333063](https://github.com/demogar/tandemise/commit/e333063fc4105f2bb7afa13b3fce709d3add9b71))
* **desktop:** brand palette as an enforced design system, with a matching logo ([#12](https://github.com/demogar/tandemise/issues/12)) ([c4f769c](https://github.com/demogar/tandemise/commit/c4f769c007ad24d6ba083721cfa57e54f0a35145))
* **desktop:** every mission, task, plan, approval, run and artifact shows its id ([634fd32](https://github.com/demogar/tandemise/commit/634fd324e15baa375838e5454831bebc97d05ac5))
* **desktop:** give the app its own name and mark ([240314f](https://github.com/demogar/tandemise/commit/240314f0d6830245bc470e83dfd586f850fe6138))
* **desktop:** projects, and a way to be in one ([ddecc5a](https://github.com/demogar/tandemise/commit/ddecc5a15e7e92094f49725024d9b53724b5d1a7))
* everything belongs to a project ([70a8414](https://github.com/demogar/tandemise/commit/70a8414e9a364883947096b9b61a5fe1132545bd))
* **integrations:** add an MCP server that runs as a local command ([8d6ba86](https://github.com/demogar/tandemise/commit/8d6ba860c6e652fc14794d807577c4b80e27cc2c))
* **integrations:** connect apps by signing in, the way OAuth apps work ([7cd6b67](https://github.com/demogar/tandemise/commit/7cd6b677c0487eef487be728d09ffdabad28a21c))
* **integrations:** speak MCP as a client, so any server is an integration ([e00aed6](https://github.com/demogar/tandemise/commit/e00aed67308aa7b8fb688e1bc10005296b8aa940))
* **integrations:** tool broker, run-scoped MCP gateway, GitHub, browser ([b21c279](https://github.com/demogar/tandemise/commit/b21c2796a68da4b3bf0d465dc84c57f9c8329e2d))
* **loops:** workers ask you questions, and your feedback becomes the revision ([701cce5](https://github.com/demogar/tandemise/commit/701cce59ae6447dcdbf1d90600417ffbaa4c3140))
* persistence, policy, artifacts, context, evaluation verified ([e15e146](https://github.com/demogar/tandemise/commit/e15e1469cd25b4367bc50406c3959346c60b935a))
* **planning:** a task using an asynchronous app waits for its result ([10f9203](https://github.com/demogar/tandemise/commit/10f9203a45758a9a447295ed678b6e38a2d5215b))
* **planning:** planner prompt and plan extraction ([ab720b0](https://github.com/demogar/tandemise/commit/ab720b0009306d540b3c39469f365cee98e82466))
* **planning:** the planner knows which apps are connected ([5409bb6](https://github.com/demogar/tandemise/commit/5409bb620bb9ea37d875a659c28ca60605561b87))
* run a workflow from the app, and wait on the world outside ([b6bf55d](https://github.com/demogar/tandemise/commit/b6bf55d943755a7bf9f7630e4203b33efd742895))
* runtime adapters, execution layer, policy, persistence, artifacts, context ([e060109](https://github.com/demogar/tandemise/commit/e0601098bfd9da561b9c2371c47f0381cd0718d1))
* **runtime-codex:** Codex CLI adapter ([3a5cd53](https://github.com/demogar/tandemise/commit/3a5cd53a98fa1c84791127d5956ee0805884dbb8))
* **runtimes:** per-profile config directory, and a settings form that adapters define ([4a6220e](https://github.com/demogar/tandemise/commit/4a6220e13e1dd833d9eb8c7443015185e9adc6a6))
* **tasks:** retry a task with more access ([105451a](https://github.com/demogar/tandemise/commit/105451a7e0602726a0ff6592a55d2bd03eb612cf))
* workflows a team writes, and steps a person does ([6bd934e](https://github.com/demogar/tandemise/commit/6bd934ea4f07417e6a182f492b5c4e5c69acb783))


### Bug Fixes

* **application:** give reviewers and testers the actual change ([abbdbe7](https://github.com/demogar/tandemise/commit/abbdbe76fd9ee460f3a5652c8a84dbe79225d7f8))
* **approvals:** 'Retry once more' on an exhausted task did nothing ([fcdef5a](https://github.com/demogar/tandemise/commit/fcdef5ad18f24ad5a4ceddd14728ce1ea67e6865))
* **artifacts:** a decision record following its own template was refused ([6afc607](https://github.com/demogar/tandemise/commit/6afc6072d156a32db2720c7423ffb2ec2d62a6c3))
* **artifacts:** parallel research silently replaced each other's briefs ([0749387](https://github.com/demogar/tandemise/commit/07493871d2d8dffb74c222000c9c42ccf9500b3c))
* **build:** tighten boundary import detection; declare kernel in browser and github ([cf0c96b](https://github.com/demogar/tandemise/commit/cf0c96b6486cff9b8a4ff5549b984a77983a7115))
* **daemon:** connected MCP servers published no tools after a restart ([ac95c7f](https://github.com/demogar/tandemise/commit/ac95c7f68b779cd7b5dc5d7676c557ad32c5148a))
* **daemon:** let the desktop renderer read its responses ([eaae1d8](https://github.com/demogar/tandemise/commit/eaae1d86891deb418c0ff19075afe51093516412))
* **daemon:** Plan mission never left the form ([23d8d96](https://github.com/demogar/tandemise/commit/23d8d968b41ddb633a4fae81a84bf46751a48416))
* **daemon:** seed a workspace on first start ([5de4b11](https://github.com/demogar/tandemise/commit/5de4b118814501468f2e6c8550e08fee7eabcb28))
* **daemon:** start the scheduler, and bind execution-core's own tokens ([d9c014e](https://github.com/demogar/tandemise/commit/d9c014ed353a2ba28545a4eee7d54a20a0213b52))
* **daemon:** stop requiring a workspace the desktop has not chosen yet ([96019bb](https://github.com/demogar/tandemise/commit/96019bb94ad9d0e7fe540c465f78eb1f88eaa256))
* **desktop:** survive a daemon of a different vintage, and stop selecting chrome ([02ed88f](https://github.com/demogar/tandemise/commit/02ed88fcd9210ca66ff3a70f359e281f035362d3))
* **desktop:** the approval card blanked the app with a value import from domain ([eedf9c8](https://github.com/demogar/tandemise/commit/eedf9c8ca99b4994bd457c71dddf7551481fefcc))
* **engine:** a forgotten session no longer strands a task ([10dd78a](https://github.com/demogar/tandemise/commit/10dd78a7a994eba57908b8d185362658ea32fe84))
* **engine:** a forgotten session no longer strands a task ([ba5716e](https://github.com/demogar/tandemise/commit/ba5716e61ee7004e495bcee832d005224c08fe06))
* **execution:** concurrent mkdirs in a shared checkout no longer fail with EEXIST ([#13](https://github.com/demogar/tandemise/issues/13)) ([6464316](https://github.com/demogar/tandemise/commit/6464316fa42e807443f3c7347f49b5c5992710ce))
* **execution:** prevent worktree collisions and unsafe detached-HEAD reuse ([eb19fc4](https://github.com/demogar/tandemise/commit/eb19fc40567290ecf7a8965453f5b72fcb7a814a))
* **executor:** a restart spent the task's retry budget ([3b2ed3a](https://github.com/demogar/tandemise/commit/3b2ed3a21399fa26fb7a16bc867c3b7913894281))
* **executor:** a resumed run collided with the attempt it continues ([a61f7df](https://github.com/demogar/tandemise/commit/a61f7df17ec9dde0ae74e7ce0a40da914d12f7e1))
* **executor:** a task could push its branch but never open its pull request ([57909c0](https://github.com/demogar/tandemise/commit/57909c00ef95f68fc1c481c9c978717db0ef6ae8))
* **executor:** an evaluator that found problems was re-run instead of fixed ([97cbe40](https://github.com/demogar/tandemise/commit/97cbe401fd7379d8975de315ac15839e255953a0))
* **executor:** stopping a run to retry it cancelled the retry ([a82a1cd](https://github.com/demogar/tandemise/commit/a82a1cd49d7004abc50a4506c634085214566edd))
* **git:** end option parsing before caller-supplied refs ([ad44dd8](https://github.com/demogar/tandemise/commit/ad44dd8ced0caffddf297d64383a1f52f9a16c15))
* **github:** checks.list failed on every call with older gh ([4f5c6d8](https://github.com/demogar/tandemise/commit/4f5c6d831a1c6c8960aaae94f0186a57d9701aa0))
* keep the desktop icon sources out of the build ignore ([4803fba](https://github.com/demogar/tandemise/commit/4803fba6433bb97fbb56464d1260ff6915181bf2))
* **missions:** retrying a task left its dependents running on the old result ([bd714e0](https://github.com/demogar/tandemise/commit/bd714e062975e76fe63d79343bffac81640cf19f))
* **missions:** skipping a task left its approval cards open ([6612543](https://github.com/demogar/tandemise/commit/6612543a7101e140110b6da844c5d27bfb5cd56f))
* nine defects from the persistence/daemon review ([2f9b255](https://github.com/demogar/tandemise/commit/2f9b255ffd1887e8a7e5b1b32465bbd421efdaa9))
* **persistence:** let a task actually record that it is parked ([f309eae](https://github.com/demogar/tandemise/commit/f309eaef1686660e1f76f25918fd95e6f261d549))
* **planning:** a detailed plan was cut off and thrown away ([8bb2d0a](https://github.com/demogar/tandemise/commit/8bb2d0a972211615203c3aec570df45386039348))
* **policy:** a connected-app grant covered no app ([a8582e0](https://github.com/demogar/tandemise/commit/a8582e09a0cf23b3f9490bd326f1d56663a9fba8))
* **policy:** close three fail-open paths in the permission engine ([40f6899](https://github.com/demogar/tandemise/commit/40f689975fc56703237e1f27c68e64aa4d868f82))
* **policy:** gate the default external-writes dial on plan approval ([38ac740](https://github.com/demogar/tandemise/commit/38ac7408583ed35b812b1a33f6973d2db09ee1fc))
* **policy:** neutralize fence sentinels in labels, not only bodies ([704341a](https://github.com/demogar/tandemise/commit/704341a9f6ce4ae895a37702444d1d68ef124877))
* **recovery:** a task could be stranded RUNNING with nothing running ([0ffabfe](https://github.com/demogar/tandemise/commit/0ffabfec31caede0363882aceea8068487f9a90f))
* **recovery:** reopen a completed mission that still has work queued ([a8101b2](https://github.com/demogar/tandemise/commit/a8101b2aaaf9bf31403250d1c4ee252effc71388))
* **roles:** projects seeded before the timestamp fix still upgrade ([bf8554b](https://github.com/demogar/tandemise/commit/bf8554bc271a9a694ced1cd3d3e71e09f62fa459))
* **roles:** shipped role upgrades never reached an existing install ([5913216](https://github.com/demogar/tandemise/commit/59132162e4de053dcde8b686274df743dc5eb0ba))
* **runtime-claude:** no worker could call a connected app's tools ([ec2ebc4](https://github.com/demogar/tandemise/commit/ec2ebc40e9d3f9041af1ca38ea6c3febd9e972ec))
* **runtime-claude:** workers ran the user's personal hooks, plugins and skills ([593ff8b](https://github.com/demogar/tandemise/commit/593ff8b5db44db9b21002e8d4db89ab3d058247d))
* **runtime:** a signed-out runtime makes work wait instead of blocking it ([6e46605](https://github.com/demogar/tandemise/commit/6e46605e78e7d22fb43cc6ba187597e67fcfd536))
* **runtimes:** claim the concurrency slot at start, not on first read ([0cec4e7](https://github.com/demogar/tandemise/commit/0cec4e76b5fa606e80a790f8b2114b52316b180d))
* **runtimes:** MultiEdit file changes, relative path probing, line recovery ([d73e329](https://github.com/demogar/tandemise/commit/d73e329e753f89a1428230ab3828a4702d487e23))
* **runtimes:** withhold unrelated credentials from worker processes ([12c58f3](https://github.com/demogar/tandemise/commit/12c58f3d78aefd04186ca95219d6b105387a837a))
* **scheduler:** a mission with a cancelled task was marked complete ([0709dc5](https://github.com/demogar/tandemise/commit/0709dc5a63b4dd8da3e16384a21d6d6548114329))
* **scheduler:** restarting the daemon cancelled the work it was doing ([181d723](https://github.com/demogar/tandemise/commit/181d72322307dfd2793921bffe442f7ff8fa8fff))
* **scheduler:** retrying a dead task left its dependents blocked forever ([7d4377d](https://github.com/demogar/tandemise/commit/7d4377d5a4143b248a4c009e3cf99de28bd74f84))
* schemaless artifacts could never pass, and waiting looked like stuck ([128109d](https://github.com/demogar/tandemise/commit/128109d89f835463120679ea258bedef78a51b3f))
* **security:** close symlink sandbox escape in ScopedFileSystem ([7bc04ca](https://github.com/demogar/tandemise/commit/7bc04ca78d3c0280ede2efa2824830b58c31b3c9))
* **security:** workers inherited the user's own MCP servers ([ddab2ab](https://github.com/demogar/tandemise/commit/ddab2abdaaf7e6223a4a45a13b55ab7fd61e8cca))
* what running real missions through the app broke ([fd922f8](https://github.com/demogar/tandemise/commit/fd922f885af32aa79c3db07399ed3ebfc0154f37))
* **workflows:** a step inherits its role's isolation ([ac0f191](https://github.com/demogar/tandemise/commit/ac0f1917ba8661a391bd741f3c14b7edb3f07a89))


### Performance

* **execution:** seed installed dependencies into fresh worktrees ([5312d55](https://github.com/demogar/tandemise/commit/5312d5545d86e6085356605697890273db56ed9c))
* **scheduler:** read-only tasks in one checkout no longer take turns ([0749a7e](https://github.com/demogar/tandemise/commit/0749a7e98ffdb2ed70276b8b9d71493e89a097ef))


### Refactoring

* **domain:** drop unused parameter in gate failure explanation ([6a4d392](https://github.com/demogar/tandemise/commit/6a4d392f0d033027ea37875d799af6512f40ce75))
* **roles:** code-host grants in their own table; seeded roles read as unedited ([afd6083](https://github.com/demogar/tandemise/commit/afd608318c786a393fc5497dc4cc460542b5d0b1))


### Documentation

* acceptance criteria evidence tracker ([eeada7e](https://github.com/demogar/tandemise/commit/eeada7e8510c26774aa03c94abee5356ed83f73b))
* application layer design ([702941e](https://github.com/demogar/tandemise/commit/702941e5c54e05004643e6db0004765f865a4d7f))
* architecture decision records ([ae091bb](https://github.com/demogar/tandemise/commit/ae091bb11670ee5a6e50b4bf617834b874a7036c))
* final acceptance record ([35ec5d5](https://github.com/demogar/tandemise/commit/35ec5d5d4cc742b3008bea875a1f140096fec5f9))
* quickstart ([032db90](https://github.com/demogar/tandemise/commit/032db90ee5940516f6fa36daa964c4cdf9933a94))
* README ([4c54bfd](https://github.com/demogar/tandemise/commit/4c54bfda718b20558855346ea224b8a29245faa5))
* record the acceptance criteria now demonstrated end to end ([78eb1f0](https://github.com/demogar/tandemise/commit/78eb1f083e26b6784dd4c3398df81fc42b40fd15))
* record the second review pass ([a73ade8](https://github.com/demogar/tandemise/commit/a73ade8670fada5f13db4da4094921feee9145a1))
* record verified acceptance criteria ([7215d62](https://github.com/demogar/tandemise/commit/7215d62b1c1bc18d5d8328d5434cba8817e774c8))
* record verified criteria and the security fixes from review ([4b77b43](https://github.com/demogar/tandemise/commit/4b77b433046c8aa6fb3cfc392bfce2d0345d5b19))
