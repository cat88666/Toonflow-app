# Toonflow

Toonflow 是面向 AI 短剧生产的开源工作台，覆盖原著导入、剧本改编、角色与场景生成、分镜制作、视频生成和成片导出。

## 主要功能

- 无限画布：统一组织剧本、角色、场景、分镜、素材和视频节点。
- Agent 协作：由决策层、执行层和监督层完成任务拆解、内容生成与质量审阅。
- 持久化记忆：通过本地 ONNX 向量检索保存摘要并进行语义召回。
- 可编程供应商：在设置中心编写 TypeScript 逻辑，接入不同的文本、图像和视频模型。
- 事件图谱：提取原著章节事件，为剧本改编提供结构化上下文。
- Skill 配置：使用 Markdown 文件管理 ScriptAgent 和 ProductionAgent 的核心提示词。

## 快速开始

### 配置模型

使用前需要准备：

- 大语言模型服务接口
- 图片生成模型服务接口
- 视频生成模型服务接口

进入设置中心添加模型供应商，完成后按以下流程创建内容：

1. 新建项目并导入原著。
2. 提取章节事件。
3. 使用 ScriptAgent 生成故事骨架、改编策略和剧本。
4. 使用 ProductionAgent 编排分镜、素材和视频节点。
5. 调整分镜并导出成片。

## Docker 部署

要求 Docker 20.10 或更高版本。

```bash
git clone https://github.com/HBAI-Ltd/Toonflow-app.git
cd Toonflow-app

docker build -t toonflow .
docker run -d \
  --name toonflow \
  -p 10588:10588 \
  -v /path/to/data:/app/data \
  toonflow
```

启动后访问 `http://localhost:10588/web/index.html`。

### 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `NODE_ENV` | 运行环境，生产环境使用 `prod` | - |
| `PORT` | 服务监听端口 | `10588` |
| `OSSURL` | 静态资源访问地址 | - |

## 源码开发

### 环境要求

- Node.js 23.11.1 或更高版本，推荐 Node.js 24
- Yarn

### 启动项目

```bash
git clone https://github.com/HBAI-Ltd/Toonflow-app.git
cd Toonflow-app
yarn install
```

仅启动后端 API 服务：

```bash
yarn dev
```

启动后端服务和 Electron 客户端：

```bash
yarn dev:gui
```

### 构建与检查

```bash
yarn lint
yarn build
```

平台安装包构建命令：

```bash
yarn dist:win
yarn dist:mac
yarn dist:linux
```

生产环境启动编译后的服务：

```bash
yarn start
```

## 服务器部署

完成依赖安装和构建后，可使用 PM2 运行生产服务：

```bash
npm install -g pm2
yarn install
yarn build
NODE_ENV=prod PORT=10588 pm2 start data/serve/app.js --name toonflow-app
pm2 save
```

如需对外提供服务，请自行配置反向代理、HTTPS、防火墙和持久化数据目录。

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 语言 | TypeScript |
| 服务端 | Express、Socket.IO |
| 桌面端 | Electron |
| 数据库 | SQLite、Knex |
| AI 集成 | Vercel AI SDK、Transformers.js |
| 图像处理 | Sharp |
| 容器化 | Docker |

## 项目结构

```text
build/                    编译产物
data/                     运行时数据、模型、Skill 和内置前端
docs/                     文档资源
scripts/                  构建及辅助脚本
src/
  agents/                 ScriptAgent 和 ProductionAgent
  lib/                    数据库及公共库
  middleware/             Express 中间件
  routes/                 API 路由
  socket/                 实时通信
  types/                  TypeScript 类型
  utils/                  工具函数
  app.ts                  应用入口
Dockerfile                Docker 构建文件
electron-builder.yml      Electron 打包配置
```


