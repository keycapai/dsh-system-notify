# 发布流程

本仓库的发布由 **tag 驱动**，不靠手动 `npm publish`。

## 一次性配置

### 1. npm Trusted Publishing（推荐，无需长期 token）

在 <https://www.npmjs.com/package/dsh-system-notify/access> → **Trusted publishing** 添加：

| 字段 | 值 |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `keycapai` |
| Repository | `dsh-system-notify` |
| Workflow filename | `release.yml` |
| Environment | 留空 |

配好之后，`release.yml` 用 OIDC 现场换取短期凭据，仓库里不需要存任何 npm token。

> **注意**：Trusted publishing 只能给**已存在**的包配置。所以第一次发布必须先手动推一次
> （见下），之后才能享受免 token。

### 2. 备用方案：NPM_TOKEN

如果暂时不配 Trusted Publishing，就在仓库的 **Settings → Secrets and variables → Actions**
里加一个 `NPM_TOKEN`（npmjs.com → Access Tokens → Granular，勾 *Read and write*）。
`release.yml` 会自动回退到它。

## 首次发布（仅一次，需要 2FA）

```bash
cd dsh-system-notify
npm publish --access public     # 输入认证器里的 6 位 OTP

cd ../dsh-plugin-updater
npm publish --access public
```

## 之后的每次发布

```bash
# 1. 升版本号并打 tag（会自动 commit）
npm version patch      # 修 bug：1.1.1 -> 1.1.2
npm version minor      # 加功能：1.1.1 -> 1.2.0
npm version major      # 破坏性变更：1.1.1 -> 2.0.0

# 2. 推上去，release.yml 接手
git push --follow-tags
```

工作流会依次：

1. 装依赖、跑测试——**测试不过就不发**；
2. 校验 tag 与 `package.json` 的 version 一致——打错 tag 直接失败，不会发错版本；
3. `npm pack` 出一个 tarball；
4. 用 OIDC（或 `NPM_TOKEN`）发布，带 `--provenance` 生成可验证的来源证明；
5. 把同一个 tarball 挂到 GitHub Release 上，并自动生成 release notes。

## 手动试跑

**Actions → Release → Run workflow**，`dry_run` 默认为 `true`：
只装依赖、跑测试、打包，**不发布**。用来验证流水线本身是通的。

## 为什么 tag 和 package.json 必须一致

`npm version` 会同时改 `package.json` 和打 tag。如果有人只打了 tag 而忘了升版本，
或者手工改了版本号，工作流会拒绝发布并指出两个值分别是什么——宁可红，也不要发一个
版本号对不上的包出去。
