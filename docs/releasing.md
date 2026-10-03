# Page Bridge 发布清单

发布前先确认工作树干净，并从目标基线创建发布分支。版本号、扩展产物和 GitHub Release 必须指向同一个版本。

1. 修改 `package.json` 与 `extension/manifest.json` 的 `version`，保持完全一致。
2. 运行 `npm run test:browser:fixtures`，让 `dev/make-popup-preview.mjs` 从 manifest 读取新版本并重新生成 `docs/popup-preview.png`。
3. 运行全部检查：

   ```text
   npm run check
   npm run test:policy
   npm run test:page-op-regions
   npm run test:auth
   npm run test:log
   npm run test:fuzz
   npm run test:queue
   npm run test:native
   npm run test:mcp
   ```

4. 确认扩展实机重载后，`node page.mjs status --json` 的 `extensionVersion` 等于目标版本，且 `clients[].instance` 是 16 位实例标识。
5. 提交版本变更并创建带注释的 tag：

   ```powershell
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```

6. 在 GitHub 创建 Release，并选择刚推送的 `vX.Y.Z` tag。发布后通过 GitHub API 检查：

   ```text
   GET /repos/<owner>/<repo>/releases/latest
   latest.tag_name == "v" + extension/manifest.json.version
   ```

`v0.6.1` 如果仍然只有裸 tag，应单独决定是否补 Release；不要让补 Release 的动作混入新版本提交。推送和创建 Release 属于外部写操作，必须由发布者明确执行并核对远端结果。
