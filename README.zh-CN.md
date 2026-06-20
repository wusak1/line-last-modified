[简体中文](README.zh-CN.md) / [English](README.md)

<h1 align="center">Line Last Modified</h1>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-7c3aed?style=flat-square" alt="version 1.0.0">
  <img src="https://img.shields.io/badge/Obsidian-%E2%89%A51.5.0-7c3aed?style=flat-square" alt="Obsidian 1.5.0 or later">
  <img src="https://img.shields.io/badge/platform-desktop%20%7C%20mobile-2563eb?style=flat-square" alt="desktop and mobile">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16a34a?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <strong>在光标当前行显示最后修改时间，并把本机、跨设备和 Git 历史统一起来。</strong>
  <br>
  <em>不向 Markdown 正文写入时间戳或隐藏标记。</em>
</p>

---

## 🎯 核心功能

- **🕒 当前行时间戳**
  - 仅在光标所在行显示一个不可编辑的时间戳。
  - 支持相对时间、绝对时间和两者同时显示。
  - 可设置超过指定小时或天数后自动改为绝对时间。
  - 支持当前行旁、编辑器边栏和状态栏三种位置。
  - 可设置有效修改阈值，默认累计净变化达到 5 个字符才更新时间，避免误触被记录。

- **📓 日记模式**
  - 自动识别 Daily Notes、日期文件名和指定日记文件夹。
  - 区分当日记录、次日补记、延迟补记、后期回改和预写。
  - 提供 GitHub 风格的 7 天与 30 天日记热力图。
  - 可选旧日记提醒、编辑确认和本机 IndexedDB 快照。

- **🧠 知识库模式**
  - 根据可靠修改时间显示新鲜、待复核或可能过期状态。
  - 提供知识维护看板、反向链接排序和行级热力图。
  - 支持知识影响分析和“标记为已复核”，不会覆盖最后编辑时间。

- **🔄 跨设备历史**
  - 每台设备只写自己的 JSONL 事件分片，降低同步冲突概率。
  - 支持 Obsidian Sync、Syncthing、Remotely Save、FastNoteSync 等完整 Vault 同步方案。
  - 桌面端可以生成 Git blame 缓存，移动端无需原生 Git 即可读取。
  - 损坏的单行 JSONL、同步交错或 Git 错误不会中断编辑。

- **🌳 Git 历史（可选）**
  - 桌面端通过 `git blame --line-porcelain` 获取已提交历史。
  - 能识别当前 Vault、父级仓库、指定仓库和无仓库状态。
  - 初始化仓库必须由用户明确确认；不会自动 add、commit、配置作者或 remote。
  - Obsidian Git 仅做安装状态检测和操作引导，不读取私有 API。

- **🔐 隐私与设备验证（可选）**
  - 默认不保存正文预览、diff、摘要、情绪或人物分析。
  - 支持隐藏作者与设备、仅保留时间戳等隐私等级。
  - 可选 P-256 设备签名、指纹信任、撤销和密钥轮换。
  - 可选 HMAC-SHA-256 内容哈希；密钥只保存在本机。

- **📊 本地回顾（可选）**
  - 按命令生成本地周回顾和月回顾。
  - 统计标题、标签、链接、可见字数、日记主题和知识复核风险。
  - 默认关闭，不调用模型、不联网、不保存结果，也不修改笔记。

## 🚀 快速安装

### 方式一：安装 ZIP（推荐）

1. 从 [GitHub Releases](https://github.com/wusak1/line-last-modified/releases) 下载最新的 `line-last-modified-*.zip`。
2. 解压后确认文件夹内只有：

   ```text
   manifest.json
   main.js
   styles.css
   ```

3. 将该文件夹复制到：

   ```text
   <你的 Vault>/.obsidian/plugins/line-last-modified/
   ```

4. 重载 Obsidian，在“设置 → 第三方插件”中启用 **Line Last Modified**。

### 方式二：从源码构建

```bash
npm install
npm run typecheck
npm test
npm run build
```

随后将根目录的 `manifest.json`、`main.js`、`styles.css` 复制到插件目录。

## 📖 首次使用

设置页按“第一次打开也能理解”的方式组织：

1. **从这里开始**
   - 开启当前行时间戳。
   - 选择时间样式、显示位置和语言。

2. **使用场景**
   - 推荐选择“自动识别”。
   - 也可选择“主要用于日记”“主要用于知识库”或“仅普通时间戳”。
   - 日记和知识库文件夹均为可选，通常不需要填写。

3. **移动光标并编辑**
   - 光标切换到某一行时显示该行时间。
   - 修改该行后立即刷新为本机编辑时间。

4. **按需展开高级设置**
   - 外观、日记规则、知识维护、Git、同步、隐私和性能默认折叠。
   - 当前用途不需要的设置会自动隐藏。

## 🔄 跨设备同步

默认元数据目录为：

```text
line-last-modified/
├─ events/<deviceId>/*.jsonl
├─ devices/<deviceId>.json
├─ blame-cache/<deviceId>/*.json
└─ cache/<deviceId>/index.json
```

同步服务必须包含该目录中的 `.json` 和 `.jsonl` 文件。只同步 Markdown 的方案无法传递行历史。

### FastNoteSync

使用 FastNoteSync 时，请确保其同步范围包含普通文件和 `line-last-modified/` 目录。插件不依赖 FastNoteSync 的专用 API；同步完成后，通过 Vault 文件变化自动重载历史。

### 多设备建议

- 每台设备使用不同的设备身份，不要手动复制本机 localStorage。
- 同步笔记和 `line-last-modified/`，但不要同步 `.git`。
- 如需跨设备 Git 历史，在桌面设备分别 Clone 同一个远程仓库。
- HMAC 模式下，各设备需要通过独立安全渠道配置同一个本机密钥。

## 🧭 时间来源优先级

```text
当前内存编辑
> 当前设备事件日志
> 其他设备同步事件
> 桌面 Git blame 或同步 blame 缓存
> 文件系统修改时间
> 明确的无历史或错误状态
```

点击时间戳，或执行“解释当前行历史”，可以查看候选来源、匹配依据、可信度、冲突、签名状态和 Git 回退原因。

## ⌨️ 常用命令

- 切换当前行时间戳
- 解释当前行历史
- 刷新同步行历史和 Git 缓存
- 立即保存待写入的行历史
- 打开日记回顾
- 打开知识待复核列表
- 打开知识影响分析
- 打开跨日迁移候选
- 打开本地周回顾 / 月回顾
- 将当前知识笔记标记为已复核
- 审计同步元数据隐私

## 🔐 数据与隐私边界

### 不会静默写入 Markdown

插件不会插入时间戳、隐藏 ID、模式状态或迁移标记。只有用户明确执行日记回顾导出或快照恢复时才会修改 Markdown。

### 仅保存在当前设备

- Git 可执行文件路径和仓库绝对路径
- 本机设备设置和序号
- 设备信任与撤销决定
- P-256 私钥和日记快照
- HMAC 内容哈希密钥

### 可同步元数据

- Vault 相对文件路径、行号和时间戳
- 默认开启的短内容与上下文哈希
- 事件设备 ID、事件序号和可选设备显示名称
- 可选签名、公钥和桌面 Git blame 缓存

设备签名只验证来源和完整性，不会加密元数据。需要保密时，请使用同步服务自身经过审计的加密能力。

## ⚙️ 兼容性

- Obsidian：`1.5.0` 或更高版本
- 桌面端：Windows、macOS、Linux
- 移动端：Android、iOS（不调用 Node `child_process`，不依赖原生 Git）
- 同步：Obsidian Sync、Syncthing、Remotely Save、FastNoteSync 及其他完整 Vault 文件同步方案

## 🧪 开发验证

```bash
npm run typecheck
npm test
npm run build
npm run verify-release
```

当前自动测试覆盖功能、损坏数据、并发同步、移动端、隐私和 10 万事件查询性能。

## ⏱️ 更新日志与设计文档

- [更新日志](CHANGELOG.md)
- [设备信任威胁模型](docs/DEVICE_TRUST_THREAT_MODEL.md)
- [Obsidian Git Provider 决策](docs/OBSIDIAN_GIT_PROVIDER_DECISION.md)

## 💬 问题与建议

发现问题或希望增加功能时，请在 [GitHub Issues](https://github.com/wusak1/line-last-modified/issues) 提交，并附上：

- Obsidian 与插件版本
- 桌面或移动平台
- 使用的同步方案
- 可复现步骤和脱敏后的错误信息

## 📄 许可证

[MIT License](LICENSE)

作者：[@wusak1](https://github.com/wusak1)
