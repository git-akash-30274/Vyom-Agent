# ⚡ Vyom-Agent

> **Autonomous & Semi-Autonomous Coding Agent IDE powered by local LLMs via Ollama.**  
> Built with **Zero External Dependencies** using native Node.js and a ChatGPT/Antigravity-style dark IDE interface.

---

## 🌟 Key Features

- 🧠 **Multi-Step Autonomous ReAct Loop**: Executes an iterative loop (*Think → Tool Action → Observation → Self-Correct*) up to 100 steps until the task is verified and finished.
- 🛠️ **Built-in Coding Tools**:
  - `list_files`: Inspects files and directories inside `./workspace`.
  - `read_file`: Reads code with large-file context optimization.
  - `write_file`: Writes and auto-creates directory trees.
  - `patch_file`: Performs search-and-replace code refactoring.
  - `delete_file`: Removes outdated files and directories safely.
  - `run_command`: Executes terminal commands inside the workspace (e.g., `node app.js`, syntax checks, tests).
  - `finish`: Concludes the mission with an executive summary.
- 🔒 **Sandboxed Workspace**: All file modifications and shell commands are strictly jailed inside the `./workspace` directory to protect your host system.
- 🎨 **Native Auto-Beautifier**: Automatically structures, indents, and formats HTML, CSS, JSON, and JavaScript/TypeScript code before writing to disk—no minified single-line code.
- 🛡️ **Dual Execution Modes**:
  - **Full Auto**: The agent creates files, runs commands, tests, and self-corrects completely autonomously.
  - **Semi-Auto (Approval Required)**: Pauses before executing modifying tools (`write_file`, `patch_file`, `delete_file`, `run_command`) so you can approve or reject each action.
- 📡 **Real-Time Live SSE Streaming**: Live updates for Agent Thoughts, Tool Badges, Terminal Outputs, and step progress.
- 💻 **Complete Built-In IDE**: File explorer tree, syntax-highlighted code editor with manual save, and live terminal output.
- 🔌 **Universal Local LLM Support**: Works with **any local model** in Ollama (`qwen2.5-coder`, `deepseek-coder`, `llama3.2`, `codellama`, etc.).

---

## 📋 Prerequisites

1. **Node.js** (v18.0.0 or higher):
   ```bash
   node -v
   ```
2. **Ollama**:
   - Download & install from [ollama.com](https://ollama.com).
   - Ensure Ollama is running:
     ```bash
     ollama serve
     ```

---

## 🚀 Quick Start

### 1. Clone the Repository
```bash
git clone https://github.com/AKASH-30274/Vyom-Agent.git
cd Vyom-Agent
```

### 2. Pull Your Preferred Model
Pull any coding model of your choice using Ollama:

```bash
# Recommended default (High accuracy & balanced for 8GB-16GB RAM):
ollama pull qwen2.5-coder:7b-instruct-q4_K_M

# Fast lightweight model for low-spec CPUs (20-35 tokens/sec):
ollama pull qwen2.5-coder:3b

# Other supported coding models:
ollama pull deepseek-coder:6.7b
ollama pull llama3.2:latest
```

### 3. Start the Server
```bash
npm start
```
*Or run directly with Node:*
```bash
node server.js
```

### 4. Open the Web IDE
Open your browser and navigate to:
```
http://localhost:4545
```

---

## 🎛️ How to Use Any Ollama Model

Vyom-Agent is model-agnostic. You can switch models in three ways:

### Method 1: UI Dropdown Selector
The top bar in the Web IDE automatically detects running and available models from your local Ollama instance. Select any loaded model from the dropdown.

### Method 2: Environment Variable
Specify the model when starting the server:
```bash
DEFAULT_MODEL=qwen2.5-coder:3b npm start
```
Or with custom port and host:
```bash
PORT=5000 OLLAMA_HOST=127.0.0.1 DEFAULT_MODEL=deepseek-coder:6.7b npm start
```

### Method 3: Hardware Tuning with `Modelfile.txt`
This repository includes an optimized `Modelfile.txt` tuned for multi-core CPUs and generous context windows:

```bash
# Create a custom tuned model in Ollama:
ollama create vyom-coder -f Modelfile.txt

# Run Vyom-Agent with your custom model:
DEFAULT_MODEL=vyom-coder npm start
```

---

## 📁 Project Structure

```
Vyom-Agent/
├── server.js          # Core HTTP server, ReAct autonomous agent loop & tools
├── index.html         # Single-page Web IDE (Editor, File Tree, SSE Timeline)
├── theme.css          # Dark Mode styling & ChatGPT/Antigravity aesthetics
├── coder-agent.js     # CLI entrypoint wrapper
├── Modelfile.txt      # Reference hardware tuning parameters for Ollama
├── package.json       # Project scripts & zero-dependency configuration
├── .gitignore         # Prevents model weights and test artifacts from pushing
└── workspace/         # Isolated project sandbox where the AI writes code
    └── .gitkeep       # Keeps directory present in repository
```

---

## ⚙️ Configuration Options

You can configure the server using environment variables:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `4545` | HTTP port for the Web IDE |
| `OLLAMA_HOST` | `127.0.0.1` | Host address where Ollama is running |
| `OLLAMA_PORT` | `11434` | Port of your Ollama service |
| `DEFAULT_MODEL`| `qwen2.5-coder:7b-instruct-q4_K_M` | Default model for autonomous reasoning |

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

# Vyom-Agent
# Vyom-Agent
