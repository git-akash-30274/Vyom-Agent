/**
 * ============================================================================
 * FILE: server.js
 * DESCRIPTION: Autonomous & Semi-Autonomous Coding Agent IDE (Vyom Mode)
 * ARCHITECTURE: Multi-Step ReAct Loop (Think -> Tool Action -> Observation -> Self-Correct)
 * DEPENDENCIES: ZERO (Uses ONLY built-in Node.js modules: http, fs, path, child_process)
 * ============================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ============================================================================
// 1. CONFIGURATION & DIRECTORIES
// ============================================================================
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4545;
const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = process.env.OLLAMA_PORT ? parseInt(process.env.OLLAMA_PORT, 10) : 11434;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'qwen2.5-coder:7b-instruct-q4_K_M';
const MAX_STEPS = 100; // 100-step autonomous loop for full end-to-end project building and testing

const WORKSPACE_DIR = path.resolve(__dirname, 'workspace');
if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

// Target model list (Only the running/active Qwen model)
const FALLBACK_MODELS = [
    'qwen2.5-coder:7b-instruct-q4_K_M'
];

// Active Autonomous Session Tracker
let activeSession = null;

// ============================================================================
// 2. SECURITY & WORKSPACE FILE SYSTEM HELPERS
// ============================================================================

/**
 * Resolves and sanitizes a relative path inside WORKSPACE_DIR.
 * Prevents directory traversal attacks (e.g., ../../etc/passwd).
 */


// function resolveWorkspacePath(relativePath) {
//     if (!relativePath) return WORKSPACE_DIR;
//     // Strip leading slashes and drive specifiers
//     const clean = relativePath.toString().trim().replace(/^[/\\]+/, '');
//     const resolved = path.resolve(WORKSPACE_DIR, clean);
//     if (!resolved.startsWith(WORKSPACE_DIR)) {
//         throw new Error(`Access Denied: Path '${relativePath}' traverses outside ./workspace`);
//     }
//     return resolved;
// }

function resolveWorkspacePath(relativePath) {
    if (!relativePath) return WORKSPACE_DIR;
    const clean = relativePath.toString().trim().replace(/^[/\\]+/, '');
    const resolved = path.resolve(WORKSPACE_DIR, clean);
    
    // Safe check: relative path must not start with '..' or be absolute
    const rel = path.relative(WORKSPACE_DIR, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Access Denied: Path '${relativePath}' traverses outside ./workspace`);
    }
    return resolved;
}

/**
 * Recursively builds a tree of files and folders inside WORKSPACE_DIR.
 */
function getWorkspaceTree(dirPath = WORKSPACE_DIR, relativeRoot = '') {
    if (!fs.existsSync(dirPath)) return [];

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = [];

    // Sort folders first, then files alphabetically
    entries.sort((a, b) => {
        if (a.isDirectory() === b.isDirectory()) {
            return a.name.localeCompare(b.name);
        }
        return a.isDirectory() ? -1 : 1;
    });

    const IGNORE = new Set(['.git', 'node_modules', '.cache', 'dist', 'build', '.next']);

    for (const entry of entries) {
        if (IGNORE.has(entry.name)) continue;

        const fullPath = path.join(dirPath, entry.name);
        const relPath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
            result.push({
                name: entry.name,
                path: relPath,
                type: 'dir',
                children: getWorkspaceTree(fullPath, relPath)
            });
        } else if (entry.isFile()) {
            const stats = fs.statSync(fullPath);
            result.push({
                name: entry.name,
                path: relPath,
                type: 'file',
                size: stats.size,
                mtime: stats.mtime
            });
        }
    }
    return result;
}

/**
 * Flattens all workspace file paths into a simple relative string list for context.
 */
function getWorkspaceFileList(dirPath = WORKSPACE_DIR, relativeRoot = '', list = []) {
    if (!fs.existsSync(dirPath)) return list;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const IGNORE = new Set(['.git', 'node_modules', '.cache', 'dist', 'build', '.next']);

    for (const entry of entries) {
        if (IGNORE.has(entry.name)) continue;
        const fullPath = path.join(dirPath, entry.name);
        const relPath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            list.push(`${relPath}/ (folder)`); // <-- Shows folders to the model!
            getWorkspaceFileList(fullPath, relPath, list);
        } else if (entry.isFile()) {
            list.push(relPath);
        }
    }
    return list;
}

// ============================================================================
// 2.5 CODE FORMATTING & BEAUTIFY ENGINE (Zero External Dependencies)
// Ensures files written or patched by the AI agent are cleanly formatted and indented.
// ============================================================================

/**
 * Formats HTML/XML markup with proper 2-space indentation and clean structure.
 */
function beautifyHTML(html) {
    if (!html || typeof html !== 'string') return html || '';
    let text = html.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '  ').trim();
    const voidTags = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
    const tokens = [];
    // Tokenize tags, comments, doctype, and text
    const regex = /(<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/?[a-zA-Z0-9:-]+(?:\s+[^>]*?)?\/?>|[^<]+)/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const val = match[0].trim();
        if (val) tokens.push(val);
    }
    
    let indentLevel = 0;
    const indentStr = "  ";
    const resultLines = [];
    
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.startsWith("<!--") || token.toUpperCase().startsWith("<!DOCTYPE")) {
            resultLines.push(indentStr.repeat(indentLevel) + token);
        } else if (token.startsWith("</")) {
            indentLevel = Math.max(0, indentLevel - 1);
            resultLines.push(indentStr.repeat(indentLevel) + token);
        } else if (token.startsWith("<")) {
            const tagNameMatch = token.match(/^<([a-zA-Z0-9:-]+)/);
            const tagName = tagNameMatch ? tagNameMatch[1].toLowerCase() : "";
            const isSelfClosing = token.endsWith("/>") || voidTags.has(tagName);
            
            // Check for inline pairs: e.g. <title>My Title</title> or empty <script src="..."></script>
            if (!isSelfClosing && i + 1 < tokens.length && tokens[i+1].toLowerCase() === "</" + tagName + ">") {
                resultLines.push(indentStr.repeat(indentLevel) + token + tokens[i+1]);
                i += 1;
            } else if (!isSelfClosing && i + 2 < tokens.length && !tokens[i+1].startsWith("<") && tokens[i+2].toLowerCase() === "</" + tagName + ">") {
                resultLines.push(indentStr.repeat(indentLevel) + token + tokens[i+1] + tokens[i+2]);
                i += 2;
            } else {
                resultLines.push(indentStr.repeat(indentLevel) + token);
                if (!isSelfClosing) {
                    indentLevel++;
                }
            }
        } else {
            resultLines.push(indentStr.repeat(indentLevel) + token);
        }
    }
    return resultLines.join("\n") + "\n";
}

/**
 * Formats CSS stylesheets with clean rules, property indentation, and spacing.
 */
function beautifyCSS(css) {
    if (!css || typeof css !== 'string') return css || '';
    let text = css.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '  ').trim();
    
    text = text
        .replace(/\s*\{\s*/g, " {\n  ")
        .replace(/\s*;\s*/g, ";\n  ")
        .replace(/\s*\}\s*/g, "\n}\n\n");
        
    const lines = text.split("\n");
    const result = [];
    let inBlock = false;
    
    for (let rawLine of lines) {
        let line = rawLine.trim();
        if (!line) {
            if (result.length > 0 && result[result.length - 1] !== "") {
                result.push("");
            }
            continue;
        }
        if (line === "}") {
            inBlock = false;
            result.push("}");
        } else if (line.endsWith("{") || line.includes("{")) {
            inBlock = true;
            result.push(line);
        } else if (inBlock) {
            result.push("  " + line);
        } else {
            result.push(line);
        }
    }
    return result.join("\n").trim() + "\n";
}

/**
 * Formats single-line or minified JavaScript / TypeScript with clean line breaks and indentation.
 */
function beautifyJS(js) {
    if (!js || typeof js !== 'string') return js || '';
    let text = js.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '  ').trim();
    const lineCount = text.split('\n').length;
    // If the file already has multiple lines (> 3), preserve existing structure
    if (lineCount > 3) {
        return text.endsWith('\n') ? text : text + '\n';
    }
    
    let formatted = '';
    let indent = 0;
    const indentStr = '  ';
    let inString = false;
    let stringChar = '';
    
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const prev = text[i - 1];
        
        if (inString) {
            formatted += char;
            if (char === stringChar && prev !== '\\') {
                inString = false;
            }
            continue;
        }
        
        if (char === '"' || char === "'" || char === '`') {
            inString = true;
            stringChar = char;
            formatted += char;
            continue;
        }
        
        if (char === '{') {
            indent++;
            formatted += ' {\n' + indentStr.repeat(indent);
            while (text[i + 1] === ' ') i++;
        } else if (char === '}') {
            indent = Math.max(0, indent - 1);
            formatted += '\n' + indentStr.repeat(indent) + '}';
            while (text[i + 1] === ' ') i++;
        } else if (char === ';') {
            formatted += ';\n' + indentStr.repeat(indent);
            while (text[i + 1] === ' ') i++;
        } else {
            formatted += char;
        }
    }
    
    return formatted.split('\n').map(l => l.trimRight()).filter(l => l.trim().length > 0).join('\n') + '\n';
}

/**
 * Master code formatter: unescapes literal escaped characters and auto-formats
 * based on file extension (HTML, CSS, JSON, JS/TS).
 */
function formatCode(content, filePath = '') {
    if (!content || typeof content !== 'string') return content || '';
    
    let text = content.replace(/\r\n/g, '\n');
    const lines = text.split('\n');

    // Only unescape literal \n if the model dumped a whole file on 1 line with escaped newlines
    if (lines.length === 1 && text.includes('\\n') && text.length > 80) {
        text = text.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '  ');
    }

    const ext = (filePath.split('.').pop() || '').toLowerCase();

    // If the model already wrote multi-line code (> 3 lines), do NOT run regex beautifiers 
    // (Regex beautifiers corrupt <script> tags with '<' operators and CSS content strings)
    if (text.split('\n').length > 3 && ext !== 'json') {
        return text.endsWith('\n') ? text : text + '\n';
    }

    try {
        if (ext === 'html' || ext === 'htm' || ext === 'svg') {
            // Do not run beautifyHTML if file contains inline <script> with JS logic
            if (/<script[\s\S]*?>[\s\S]*?<\/script>/i.test(text)) {
                return text.endsWith('\n') ? text : text + '\n';
            }
            return beautifyHTML(text);
        } else if (ext === 'css' || ext === 'scss' || ext === 'less') {
            return beautifyCSS(text);
        } else if (ext === 'json') {
            const parsed = JSON.parse(text);
            return JSON.stringify(parsed, null, 2) + '\n';
        } else if (ext === 'js' || ext === 'ts' || ext === 'mjs' || ext === 'cjs') {
            return beautifyJS(text);
        }
    } catch (err) {
        return text.endsWith('\n') ? text : text + '\n';
    }

    return text.endsWith('\n') ? text : text + '\n';
}

// ============================================================================
// 3. AGENT TOOLS (Strict Execution inside ./workspace)
// ============================================================================

const AgentTools = {
    /**
     * Tool: list_files
     */
    async list_files(args) {
        const subPath = args.path || '';
        const target = resolveWorkspacePath(subPath);
        if (!fs.existsSync(target)) {
            return `Directory not found: '${subPath}'`;
        }
        const files = getWorkspaceFileList(target, subPath);
        if (files.length === 0) {
            return `Workspace folder '${subPath || '.'}' is currently empty.`;
        }
        return `Files in workspace (${files.length} items):\n` + files.map(f => `- ${f}`).join('\n');
    },

    /**
     * Tool: read_file
     */
    async read_file(args) {
        if (!args.path) throw new Error("Missing 'path' argument for read_file");
        const filePath = resolveWorkspacePath(args.path);
        if (!fs.existsSync(filePath)) {
            return `Error: File '${args.path}' does not exist in workspace.`;
        }
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            return `Error: '${args.path}' is a directory, not a file. Use list_files instead.`;
        }

        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw.split('\n');

        // Context optimization: If file is very large (> 600 lines), provide first 600 lines
        if (lines.length > 600) {
            const preview = lines.slice(0, 600).join('\n');
            return `[File '${args.path}' - showing first 600 lines of ${lines.length} lines total]\n${preview}\n\n... [Remaining ${lines.length - 600} lines truncated for context efficiency]`;
        }
        return raw;
    },

    /**
     * Tool: write_file
     */
    async write_file(args) {
        if (!args.path) throw new Error("Missing 'path' argument for write_file");
        const filePath = resolveWorkspacePath(args.path);
        const rawContent = args.content !== undefined ? String(args.content) : '';
        const content = formatCode(rawContent, args.path);

        // Auto-create parent directory structure
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(filePath, content, 'utf8');
        const bytes = Buffer.byteLength(content, 'utf8');
        const lineCount = content.split('\n').length;
        return `Successfully wrote ${bytes} bytes (${lineCount} lines) to '${args.path}'.`;
    },

    /**
     * Tool: patch_file
     */
    async patch_file(args) {
        if (!args.path) throw new Error("Missing 'path' argument for patch_file");
        if (args.search === undefined || args.replace === undefined) {
            throw new Error("Missing 'search' or 'replace' argument for patch_file");
        }
        const filePath = resolveWorkspacePath(args.path);
        if (!fs.existsSync(filePath)) {
            return `Error: File '${args.path}' does not exist to patch.`;
        }

        const original = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
        let searchStr = String(args.search).replace(/\r\n/g, '\n');
        let replaceStr = String(args.replace).replace(/\r\n/g, '\n');

        // Only unescape if exact match fails AND it looks double-escaped
        if (!original.includes(searchStr) && searchStr.includes('\\n')) {
            const unescapedSearch = searchStr.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '  ');
            if (original.includes(unescapedSearch)) {
                searchStr = unescapedSearch;
                replaceStr = replaceStr.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '  ');
            }
        }

        if (!original.includes(searchStr)) {
            const trimmedSearch = searchStr.trim();
            if (trimmedSearch && original.includes(trimmedSearch)) {
                // Use () => replaceStr to prevent $&, $$, $' replacement bugs
                const patched = original.replace(trimmedSearch, () => replaceStr);
                fs.writeFileSync(filePath, patched, 'utf8');
                return `Successfully patched '${args.path}' (matched using trimmed search block).`;
            }
            return `Error: Could not find exact search block in '${args.path}'. Verify file contents with read_file.`;
        }

        // Use () => replaceStr to safely insert code containing '$'
        const patched = original.replace(searchStr, () => replaceStr);
        fs.writeFileSync(filePath, patched, 'utf8');
        return `Successfully patched '${args.path}'.`;
    },

    /**
     * Tool: delete_file
     */
    async delete_file(args) {
        if (!args.path) throw new Error("Missing 'path' argument for delete_file");
        const targetPath = resolveWorkspacePath(args.path);
        if (!fs.existsSync(targetPath)) {
            return `File or directory '${args.path}' does not exist.`;
        }
        const stat = fs.statSync(targetPath);
        if (stat.isDirectory()) {
            fs.rmSync(targetPath, { recursive: true, force: true });
            return `Successfully deleted directory '${args.path}'.`;
        } else {
            fs.unlinkSync(targetPath);
            return `Successfully deleted file '${args.path}'.`;
        }
    },

    /**
     * Tool: run_command
     */
    async run_command(args, abortSignal) {
        if (!args.command || !args.command.trim()) {
            throw new Error("Missing 'command' argument for run_command");
        }
        const command = args.command.trim();
        
        // Prevent agent from hanging on blocking server start commands
        if (/^(npm\s+start|npm\s+run\s+dev|node\s+server\.js|nodemon|python\s+-m\s+http\.server)\b/i.test(command)) {
            return `Advisory: '${command}' starts a persistent server that will hang the terminal. Use 'node -c <file>' to check syntax or run a self-exiting test script instead.`;
        }

        return new Promise((resolve) => {
            const child = exec(command, {
                cwd: WORKSPACE_DIR,
                timeout: 35000,
                maxBuffer: 1024 * 1024 * 3, // 3MB buffer
                signal: abortSignal
            }, (error, stdout, stderr) => {
                const outText = stdout ? stdout.toString().trim() : '';
                const errText = stderr ? stderr.toString().trim() : '';

                let result = '';
                if (error) {
                    result += `Command failed with exit code ${error.code || 1}\n`;
                    if (error.killed) result += `[Process timed out after 35 seconds]\n`;
                } else {
                    result += `Command completed successfully (Exit code 0)\n`;
                }

                if (outText) {
                    result += `STDOUT:\n${outText}\n`;
                }
                if (errText) {
                    result += `STDERR:\n${errText}\n`;
                }
                if (!outText && !errText) {
                    result += `(No output recorded)`;
                }

                resolve(result.trim());
            });

            // Store running process reference on session so it can be terminated on user abort
            if (activeSession) {
                activeSession.currentChildProcess = child;
            }
        });
    },
    
    
    /**
     * Tool: create_folder
     */
    async create_folder(args) {
        if (!args.path) throw new Error("Missing 'path' argument for create_folder");
        const dirPath = resolveWorkspacePath(args.path);
        fs.mkdirSync(dirPath, { recursive: true });
        return `Successfully created folder '${args.path}'.`;
    },
    
    

    /**
     * Tool: finish
     */
    async finish(args) {
        return args.summary || "Task marked as finished.";
    }
};

// ============================================================================
// 4. OLLAMA API CALL (Strict JSON Tool-Calling Mode)
// ============================================================================

/**
 * Sends a structured prompt to Ollama with format: "json" and stream: false.
 */
function callOllamaJSON(modelName, promptText, abortSignal) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            model: modelName,
            prompt: promptText,
            // Removed format: "json" so 7B model can write long, unescaped code blocks freely
            stream: false,
            options: {
                temperature: 0.15,
                num_ctx: 16384,   // Optimal context for 7B Q4 accuracy & speed
                num_predict: 8192,
                repeat_penalty: 1.1,
                top_p: 0.9
            }
        });

        const req = http.request({
            hostname: OLLAMA_HOST,
            port: OLLAMA_PORT,
            path: '/api/generate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`Ollama API error (${res.statusCode}): ${body || res.statusMessage}`));
                }
                try {
                    const parsed = JSON.parse(body);
                    resolve(parsed.response);
                } catch (e) {
                    reject(new Error(`Failed to parse Ollama response: ${e.message}`));
                }
            });
        });

        req.on('error', (err) => {
            reject(new Error(`Ollama connection error on ${OLLAMA_HOST}:${OLLAMA_PORT}: ${err.message}`));
        });

        if (abortSignal) {
            abortSignal.addEventListener('abort', () => {
                req.destroy();
                reject(new Error('Operation aborted by user'));
            });
        }

        req.write(payload);
        req.end();
    });
}

/**
 * Supports BOTH XML-style <content> blocks (for large code files) AND standard JSON tool calls.
 */
/**
 * Robustly extracts the JSON tool call and <file_content> code block.
 * Handles unclosed <file_content> tags and ignores { } braces inside code.
 */
function extractToolCallJSON(rawResponse) {
    if (!rawResponse || typeof rawResponse !== 'string') return null;
    const cleanText = rawResponse.trim();

    let extractedCode = null;
    let jsonPart = cleanText;

    // 1. Extract <file_content> even if closing </file_content> is missing/truncated
    const openTagIndex = cleanText.indexOf('<file_content>');
    if (openTagIndex !== -1) {
        jsonPart = cleanText.substring(0, openTagIndex).trim();
        let codeBlock = cleanText.substring(openTagIndex + '<file_content>'.length);
        
        const closeTagIndex = codeBlock.lastIndexOf('</file_content>');
        if (closeTagIndex !== -1) {
            codeBlock = codeBlock.substring(0, closeTagIndex);
        }

        extractedCode = codeBlock.replace(/^\r?\n|\r?\n$/g, '');

        // Strip markdown fences if model put ```html inside <file_content>
        const innerFence = extractedCode.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/);
        if (innerFence) {
            extractedCode = innerFence[1];
        }
    }

    // 2. Helper to find the EXACT first balanced { ... } JSON object
    function extractFirstJsonObject(str) {
        const start = str.indexOf('{');
        if (start === -1) return null;

        let depth = 0;
        let inString = false;
        let escape = false;

        for (let i = start; i < str.length; i++) {
            const ch = str[i];

            if (escape) {
                escape = false;
                continue;
            }
            if (ch === '\\' && inString) {
                escape = true;
                continue;
            }
            if (ch === '"') {
                inString = !inString;
                continue;
            }
            if (!inString) {
                if (ch === '{') depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        return str.substring(start, i + 1);
                    }
                }
            }
        }
        return null;
    }

    // 3. Parse the JSON control block safely
    let parsedObj = null;

    // Try direct parse first
    try {
        parsedObj = JSON.parse(jsonPart);
    } catch (_) {}

    // Try balanced brace extraction (ignores any trailing text/code braces)
    if (!parsedObj) {
        const balancedJson = extractFirstJsonObject(jsonPart);
        if (balancedJson) {
            try {
                parsedObj = JSON.parse(balancedJson);
            } catch (_) {}
        }
    }

    // Fallback: If model forgot <file_content> tag and put ```code``` after JSON
    if (parsedObj && extractedCode === null && parsedObj.tool === 'write_file' && !parsedObj.args?.content) {
        const afterJsonIdx = cleanText.indexOf('```', cleanText.indexOf('}'));
        if (afterJsonIdx !== -1) {
            const fenceMatch = cleanText.slice(afterJsonIdx).match(/```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)(?:\r?\n```|$)/);
            if (fenceMatch) {
                extractedCode = fenceMatch[1];
            }
        }
    }

    if (parsedObj && typeof parsedObj === 'object') {
        if (!parsedObj.args || typeof parsedObj.args !== 'object') {
            parsedObj.args = {};
        }
        if (extractedCode !== null) {
            parsedObj.args.content = extractedCode;
        }
        return parsedObj;
    }

    return null;
}

/**
 * Streams plain text response from Ollama for conversational chat (e.g. greetings, general questions).
 */
function callOllamaStream(modelName, promptText, systemPrompt, abortSignal, onChunk) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            model: modelName,
            prompt: promptText,
            system: systemPrompt,
            stream: true,
            options: {
                temperature: 0.7,
                top_p: 0.95
            }
        });

        const req = http.request({
            hostname: OLLAMA_HOST,
            port: OLLAMA_PORT,
            path: '/api/generate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            if (res.statusCode !== 200) {
                let errBody = '';
                res.on('data', chunk => errBody += chunk);
                res.on('end', () => reject(new Error(`Ollama API error (${res.statusCode}): ${errBody || res.statusMessage}`)));
                return;
            }

            let lineBuffer = '';
            res.on('data', (chunk) => {
                lineBuffer += chunk.toString();
                const lines = lineBuffer.split('\n');
                lineBuffer = lines.pop(); // keep partial trailing line

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                        const parsed = JSON.parse(trimmed);
                        if (parsed.response) {
                            onChunk(parsed.response);
                        }
                    } catch (e) {}
                }
            });

            res.on('end', () => {
                if (lineBuffer.trim()) {
                    try {
                        const parsed = JSON.parse(lineBuffer.trim());
                        if (parsed.response) onChunk(parsed.response);
                    } catch (e) {}
                }
                resolve();
            });
        });

        req.on('error', (err) => {
            reject(new Error(`Ollama connection error on ${OLLAMA_HOST}:${OLLAMA_PORT}: ${err.message}`));
        });

        if (abortSignal) {
            abortSignal.addEventListener('abort', () => {
                req.destroy();
                resolve();
            });
        }

        req.write(payload);
        req.end();
    });
}

/**
 * Detects if a user message is conversational (greetings, pleasantries, general questions)
 * rather than an autonomous multi-step workspace coding task.
 */
function isConversational(task) {
    if (!task || typeof task !== 'string') return true;
    const clean = task.trim().toLowerCase();

    // 1. Direct greetings and short pleasantries
    const greetingRegex = /^(hi|hello|hey|hey there|greetings|good\s*(morning|afternoon|evening)|howdy|sup|yo|hola|namaste|hlo)[\s!.,?]*$/i;
    if (greetingRegex.test(clean)) return true;

    const pleasantryRegex = /^(thanks|thank you|thanks a lot|ty|ok|okay|cool|nice|awesome|great job|bye|goodbye|see you)[\s!.,?]*$/i;
    if (pleasantryRegex.test(clean)) return true;

    // 2. Identity and capabilities questions
    const identityRegex = /^(who are you|what are you|what can you do|what is your name|how are you|how do you work|introduce yourself|help me|help)[\s!.,?]*$/i;
    if (identityRegex.test(clean)) return true;

    // 3. Coding keywords check: if the prompt contains actions like create, write, edit, fix, etc., it's a coding mission
    const codingKeywords = /\b(create|write|make|build|add|implement|generate|run|execute|fix|debug|patch|modify|delete|remove|update|refactor|install|test|npm|node|git|html|css|js|json|python|php|file|folder|dir|directory|script|code|app|component|api|server|crud|database|endpoint|test\.js|index\.html)\b/i;

    // If there is ANY coding action keyword, it is an autonomous coding task
    if (codingKeywords.test(clean)) {
        return false;
    }

    // 4. If it's a general non-coding question (e.g. "what is recursion?", "explain javascript promises")
    if (/^(what|why|how|who|explain|tell me|can you)\b/i.test(clean) && clean.length < 120) {
        return true;
    }

    return false;
}

/**
 * Robustly parses and extracts JSON object from model's response.
 */
/**
 * 100% Bulletproof Tool Call Extractor for 7B Q4 Models.
 * Works with raw JSON, ```json blocks, broken/unclosed JSON, and <file_content> tags.
 */
function extractToolCallJSON(rawResponse) {
    if (!rawResponse || typeof rawResponse !== 'string') return null;
    let cleanText = rawResponse.trim();

    let extractedCode = null;
    let jsonPart = cleanText;

    // 1. Extract <file_content>...</file_content> first (even if unclosed at the end)
    const openTagIdx = cleanText.indexOf('<file_content>');
    if (openTagIdx !== -1) {
        jsonPart = cleanText.substring(0, openTagIdx).trim();
        let codeBlock = cleanText.substring(openTagIdx + '<file_content>'.length);

        const closeTagIdx = codeBlock.lastIndexOf('</file_content>');
        if (closeTagIdx !== -1) {
            codeBlock = codeBlock.substring(0, closeTagIdx);
        }

        extractedCode = codeBlock.replace(/^\r?\n|\r?\n$/g, '');

        // Strip markdown fences if model put ```css or ```html inside <file_content>
        extractedCode = extractedCode
            .replace(/^```[a-zA-Z0-9_-]*\r?\n/, '')
            .replace(/\r?\n```$/, '');
    }

    // 2. Strip any markdown ```json or ``` fences from jsonPart
    jsonPart = jsonPart
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

    // 3. Try standard JSON.parse first
    let parsedObj = null;
    const firstBrace = jsonPart.indexOf('{');
    const lastBrace = jsonPart.lastIndexOf('}');

    if (firstBrace !== -1 && lastBrace > firstBrace) {
        const candidate = jsonPart.substring(firstBrace, lastBrace + 1);
        try {
            parsedObj = JSON.parse(candidate);
        } catch (_) {
            // Try fixing unescaped newlines inside JSON strings
            try {
                const sanitized = candidate.replace(/\r?\n/g, ' ');
                parsedObj = JSON.parse(sanitized);
            } catch (_) {}
        }
    }

    // 4. REGEX FALLBACK (Never fails even if JSON is broken, truncated, or unescaped!)
    if (!parsedObj || !parsedObj.tool) {
        const toolMatch = cleanText.match(/"tool"\s*:\s*"([^"]+)"/i);
        if (toolMatch) {
            const thoughtMatch = cleanText.match(/"thought"\s*:\s*"([\s\S]*?)"\s*,\s*"tool"/i);
            const pathMatch = cleanText.match(/"path"\s*:\s*"([^"]+)"/i);
            const cmdMatch = cleanText.match(/"command"\s*:\s*"([^"]+)"/i);
            const summaryMatch = cleanText.match(/"summary"\s*:\s*"([\s\S]*?)"\s*\}/i);

            parsedObj = {
                thought: thoughtMatch ? thoughtMatch[1].trim() : 'Executing tool action...',
                tool: toolMatch[1].trim(),
                args: {}
            };

            if (pathMatch) parsedObj.args.path = pathMatch[1].trim();
            if (cmdMatch) parsedObj.args.command = cmdMatch[1].trim();
            if (summaryMatch) parsedObj.args.summary = summaryMatch[1].trim();
        }
    }

    // 5. Fallback if model forgot <file_content> and used a second ```code``` block after the JSON
    if (parsedObj && extractedCode === null && parsedObj.tool === 'write_file' && !parsedObj.args?.content) {
        const blocks = [...cleanText.matchAll(/```(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)```/g)];
        // If there are 2 code blocks (1st is json, 2nd is file code)
        if (blocks.length >= 2) {
            extractedCode = blocks[1][1].trim();
        } else if (blocks.length === 1 && !blocks[0][0].toLowerCase().startsWith('```json')) {
            extractedCode = blocks[0][1].trim();
        }
    }

    // 6. Finalize and return
    if (parsedObj && typeof parsedObj === 'object' && parsedObj.tool) {
        if (!parsedObj.args || typeof parsedObj.args !== 'object') {
            parsedObj.args = {};
        }
        if (extractedCode !== null) {
            parsedObj.args.content = extractedCode;
        }
        return parsedObj;
    }

    return null;
}

// ============================================================================
// 5. AUTONOMOUS AGENT ReAct LOOP
// ============================================================================

/**
 * Builds the comprehensive ReAct prompt passed to Ollama on each step with Vyom Analysis Protocol.
 */
function buildReActPrompt(userTask, currentFileList, stepHistory, touchedFiles = new Set(), notice = '') {
    const touchedArr = Array.from(touchedFiles);
    return `You are Vyom, an expert senior full-stack developer operating inside ./workspace.

HOW TO RESPOND (CRITICAL):
On every turn, output ONE JSON object for your tool call.
If you are using "write_file", DO NOT put large code inside the JSON! Put the JSON first, and put the full code below it inside <file_content>...</file_content> tags like this:

{
  "thought": "1. Folder/File Plan: I need to create 'project/css/style.css'. 2. Writing full production CSS.",
  "tool": "write_file",
  "args": {
    "path": "project/css/style.css"
  }
}
<file_content>
/* Write full, complete, unescaped multi-line code here */
body {
  margin: 0;
  padding: 0;
}
</file_content>

AVAILABLE TOOLS:
1. "create_folder": Creates a directory. args: { "path": "folder/subfolder" }
2. "write_file": Writes a file (always place code inside <file_content>...</file_content>). args: { "path": "folder/filename.ext" }
3. "patch_file": Replaces text in an existing file. args: { "path": "folder/filename.ext", "search": "old", "replace": "new" }
4. "read_file": Reads a file. args: { "path": "folder/filename.ext" }
5. "list_files": Lists workspace files. args: { "path": "" }
6. "delete_file": Deletes a file/folder. args: { "path": "folder/filename.ext" }
7. "run_command": Runs shell command in ./workspace. args: { "command": "node -c app.js" }
8. "finish": Call when all files are created and verified. args: { "summary": "Detailed summary" }

STRICT RULES FOR FOLDER STRUCTURE & LARGE CODE:
1. EXACT FILE PATHS: Always include the full relative folder path in "args.path" (e.g., "my-app/src/index.js", NOT just "index.js"). Check CURRENT WORKSPACE FILES below so you never put files in the wrong folder!
2. FOLDER STRUCTURE FIRST: For multi-file projects, first decide the folder architecture in your "thought" (e.g., "my-app/index.html", "my-app/css/style.css", "my-app/js/app.js") and keep using that EXACT prefix for every file.
3. NO SMALL/LAZY CODE: Every file you write inside <file_content> MUST be complete, detailed, and production-ready (minimum 60-250+ lines where appropriate). NEVER write "// TODO", "// add more here", or skeleton code.

CURRENT WORKSPACE FILES & FOLDERS:
${currentFileList.length > 0 ? currentFileList.map(f => '- ' + f).join('\n') : '(Workspace is currently empty)'}

FILES MODIFIED THIS RUN:
${touchedArr.length > 0 ? touchedArr.map(f => '- ' + f).join('\n') : '(None yet)'}
${notice ? `\n⚠️ ADVISORY:\n${notice}\n` : ''}
USER TASK:
${userTask}

PREVIOUS STEPS:
${stepHistory.length > 0 ? stepHistory : '(Step 1 - Start by creating the folder structure or first core file)'}

Output your JSON tool call (and <file_content> block if using write_file) now:`;
}

/**
 * Runs the Multi-Step ReAct Loop.
 * Communicates progress in real-time via the sendSSE callback.
 */
async function runAutonomousAgentLoop({
    sessionId,
    userTask,
    mode = 'full_auto', // 'full_auto' | 'semi_auto'
    model = DEFAULT_MODEL,
    maxSteps = MAX_STEPS,
    sendSSE,
    sessionState
}) {
    let currentStep = 1;
    let stepHistoryText = '';
    const touchedFiles = new Set();
    const actionHistory = [];
    let consecutivePassiveReads = 0;
    let notice = '';

    sendSSE({
        type: 'session_start',
        sessionId,
        task: userTask,
        mode,
        model,
        maxSteps,
        timestamp: new Date().toISOString()
    });

    while (currentStep <= maxSteps && !sessionState.aborted) {
        sendSSE({
            type: 'step_start',
            step: currentStep,
            maxSteps
        });

        // 1. Gather current workspace file list for context optimization
        const currentFiles = getWorkspaceFileList();

        // 2. Build ReAct Prompt with Vyom Analysis Protocol
        const prompt = buildReActPrompt(userTask, currentFiles, stepHistoryText, touchedFiles, notice);
        notice = ''; // Reset advisory after passing to prompt

        // 3. Call Ollama Model
        sendSSE({ type: 'status', message: `Thinking (Step ${currentStep}/${maxSteps})...` });

        let rawModelResponse = '';
        try {
            rawModelResponse = await callOllamaJSON(model, prompt, sessionState.abortController.signal);
        } catch (err) {
            if (sessionState.aborted) break;
            sendSSE({
                type: 'error',
                step: currentStep,
                message: `Ollama Generation Error: ${err.message}`
            });
            break;
        }

        if (sessionState.aborted) break;

        // 4. Parse Model Output to Strict Tool Call Schema
        const actionObj = extractToolCallJSON(rawModelResponse);

        if (!actionObj || !actionObj.tool) {
            const observation = `Error: Model did not produce a valid JSON tool call. Raw output received:\n${rawModelResponse.slice(0, 300)}`;
            sendSSE({
                type: 'thought',
                step: currentStep,
                thought: 'Failed to format tool call as JSON. Retrying...'
            });
            sendSSE({
                type: 'observation',
                step: currentStep,
                tool: 'error',
                output: observation
            });
            stepHistoryText += `\nStep ${currentStep}: [JSON Format Error] -> Retrying with strict schema.\n`;
            currentStep++;
            continue;
        }

        const thought = actionObj.thought || 'Vyom analyzing workspace and planning next action...';
        const toolName = (actionObj.tool || '').toLowerCase().trim();
        const toolArgs = actionObj.args || {};

        sendSSE({
            type: 'thought',
            step: currentStep,
            thought
        });

        sendSSE({
            type: 'tool_call',
            step: currentStep,
            tool: toolName,
            args: toolArgs
        });

        // 5. Handle "finish" tool
        if (toolName === 'finish') {
            const summary = toolArgs.summary || 'Task completed successfully.';
            sendSSE({
                type: 'finish',
                step: currentStep,
                summary,
                totalSteps: currentStep,
                touchedFiles: Array.from(touchedFiles)
            });
            break;
        }

        // 6. Vyom Loop & Repetition Detector
        const actionSig = `${toolName}:${toolArgs.path || ''}:${toolArgs.command || ''}`;
        const prevActionSig = actionHistory.length > 0 ? actionHistory[actionHistory.length - 1] : '';
        actionHistory.push(actionSig);

        if (actionSig === prevActionSig && toolName !== 'write_file') {
            notice = `You just executed '${toolName}' with identical arguments on the previous step. Do not repeat actions. If the goal is fulfilled, call 'finish' now.`;
        }

        // Check for passive reading loops after files have already been created
        if (touchedFiles.size > 0 && ['list_files', 'read_file'].includes(toolName)) {
            consecutivePassiveReads++;
            if (consecutivePassiveReads >= 2) {
                notice = `All requested files have been created: [${Array.from(touchedFiles).join(', ')}]. If verification is complete, call 'finish' immediately.`;
            }
            if (consecutivePassiveReads >= 3) {
                // Auto-finalize mission instead of burning remaining steps
                const autoSummary = `Task completed successfully. Created/updated ${touchedFiles.size} file(s): ${Array.from(touchedFiles).join(', ')}. All checks verified.`;
                sendSSE({
                    type: 'finish',
                    step: currentStep,
                    summary: autoSummary,
                    totalSteps: currentStep,
                    touchedFiles: Array.from(touchedFiles)
                });
                break;
            }
        } else if (['write_file', 'patch_file', 'run_command'].includes(toolName)) {
            consecutivePassiveReads = 0;
        }

        // 7. Check Semi-Auto Mode (Ask Approval before Modifying/Destructive tools)
        const isModifyingTool = ['write_file', 'patch_file', 'delete_file', 'run_command'].includes(toolName);

        if (mode === 'semi_auto' && isModifyingTool) {
            sendSSE({
                type: 'approval_required',
                step: currentStep,
                tool: toolName,
                args: toolArgs,
                stepId: `step_${currentStep}_${Date.now()}`
            });

            sessionState.isWaitingApproval = true;
            sessionState.currentApprovalStep = currentStep;

            const approvalResult = await new Promise((resolve) => {
                sessionState.approvalResolver = resolve;
            });

            sessionState.isWaitingApproval = false;
            sessionState.approvalResolver = null;

            if (sessionState.aborted) break;

            if (!approvalResult.approved) {
                const rejectReason = approvalResult.reason || 'Action rejected by user.';
                const observation = `User rejected execution of tool '${toolName}'. Feedback: ${rejectReason}`;
                
                sendSSE({
                    type: 'approval_result',
                    step: currentStep,
                    approved: false,
                    reason: rejectReason
                });

                sendSSE({
                    type: 'observation',
                    step: currentStep,
                    tool: toolName,
                    output: observation
                });

                stepHistoryText += `\nStep ${currentStep}: Tool '${toolName}' was REJECTED by user. Reason: ${rejectReason}\n`;
                currentStep++;
                continue;
            } else {
                sendSSE({
                    type: 'approval_result',
                    step: currentStep,
                    approved: true
                });
            }
        }

        // 8. Execute the Tool
        let observation = '';
        try {
            if (!AgentTools[toolName]) {
                observation = `Error: Unknown tool '${toolName}'. Supported tools: list_files, read_file, write_file, patch_file, delete_file, run_command, finish.`;
            } else {
                observation = await AgentTools[toolName](toolArgs, sessionState.abortController.signal);
                if (['create_folder', 'write_file', 'patch_file', 'delete_file'].includes(toolName) && toolArgs.path) {
                    touchedFiles.add(toolArgs.path);
                    sendSSE({
                        type: 'workspace_updated',
                        changedPath: toolArgs.path,
                        action: toolName
                    });
                }
            }
        } catch (execErr) {
            observation = `Error executing tool '${toolName}': ${execErr.message}`;
        }

        // 9. Stream Observation to Frontend
        sendSSE({
            type: 'observation',
            step: currentStep,
            tool: toolName,
            output: observation
        });

        // 10. Append Compact Step & Observation to History (Prevent Context Bloat)
        let compactArgs = { ...toolArgs };
        if (compactArgs.content && compactArgs.content.length > 100) {
            compactArgs.content = `[File content: ${(compactArgs.content || '').split('\n').length} lines written]`;
        }
        if (compactArgs.replace && compactArgs.replace.length > 100) {
            compactArgs.replace = `[Replacement block: ${(compactArgs.replace || '').split('\n').length} lines]`;
        }
        let compactObs = observation;
        if (compactObs && compactObs.length > 350) {
            compactObs = compactObs.slice(0, 350) + '... [truncated for context efficiency]';
        }

        stepHistoryText += `\nStep ${currentStep}:\nThought: ${thought.slice(0, 200)}\nAction: ${toolName} args: ${JSON.stringify(compactArgs)}\nObservation: ${compactObs}\n`;

        currentStep++;
    }

    if (currentStep > maxSteps && !sessionState.aborted) {
        sendSSE({
            type: 'max_steps_reached',
            message: `Agent reached maximum step limit (${maxSteps} steps).`,
            touchedFiles: Array.from(touchedFiles)
        });
    }

    if (sessionState.aborted) {
        sendSSE({
            type: 'aborted',
            message: 'Agent execution was stopped by user.'
        });
    }

    sendSSE({ type: 'session_end' });
}

// ============================================================================
// 6. HTTP SERVER & API ROUTES
// ============================================================================

const server = http.createServer(async (req, res) => {
    // Enable CORS for development flexibility
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Helper to read JSON request body
    const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB limit for folder imports
    const readJSONBody = () => new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
                req.destroy();
                return reject(new Error('Payload too large (exceeds 50MB limit)'));
            }
            body += chunk;
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                reject(new Error('Invalid JSON payload: ' + err.message));
            }
        });
        req.on('error', reject);
    });

    // ------------------------------------------------------------------------
    // ROUTE: Static File Serving (index.html, theme.css)
    // ------------------------------------------------------------------------
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const filePath = path.join(__dirname, 'index.html');
        if (fs.existsSync(filePath)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(fs.readFileSync(filePath, 'utf8'));
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('index.html not found in workspace.');
        }
    }

    if (req.method === 'GET' && pathname === '/theme.css') {
        const cssPath = path.join(__dirname, 'theme.css');
        if (fs.existsSync(cssPath)) {
            res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
            return res.end(fs.readFileSync(cssPath, 'utf8'));
        } else {
            res.writeHead(200, { 'Content-Type': 'text/css' });
            return res.end('/* theme.css not found */');
        }
    }

    if (req.method === 'GET' && pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
    }

    // ------------------------------------------------------------------------
    // ROUTE: Get Available / Running Ollama Models
    // Queries /api/ps first to show only the actively running model(s).
    // If idle, falls back strictly to the active model (qwen2.5-coder:7b-instruct-q4_K_M).
    // ------------------------------------------------------------------------
    if (req.method === 'GET' && pathname === '/api/models') {
        const psReq = http.request({
            hostname: OLLAMA_HOST,
            port: OLLAMA_PORT,
            path: '/api/ps',
            method: 'GET',
            timeout: 2500
        }, (ollamaRes) => {
            let data = '';
            ollamaRes.on('data', c => data += c);
            ollamaRes.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const runningModels = (parsed.models || []).map(m => m.name);
                    
                    // If a model is actively running in memory, show only the running model(s)
                    if (runningModels.length > 0) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({
                            models: runningModels,
                            default: runningModels[0],
                            status: 'running'
                        }));
                    }
                } catch (_) {}

                // If no model is currently in memory, verify installed tags and filter strictly for the active Qwen model
                const tagsReq = http.request({
                    hostname: OLLAMA_HOST,
                    port: OLLAMA_PORT,
                    path: '/api/tags',
                    method: 'GET',
                    timeout: 2500
                }, (tagsRes) => {
                    let tagsData = '';
                    tagsRes.on('data', c => tagsData += c);
                    tagsRes.on('end', () => {
                        try {
                            const parsedTags = JSON.parse(tagsData);
                            const allModels = (parsedTags.models || []).map(m => m.name);
                            // Filter specifically for the Qwen 7B model or DEFAULT_MODEL
                            const target = allModels.find(m => m === DEFAULT_MODEL || m.includes('qwen2.5-coder:7b') || m.includes('qwen'));
                            const activeModel = target || DEFAULT_MODEL;

                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            return res.end(JSON.stringify({
                                models: [activeModel],
                                default: activeModel,
                                status: 'ready'
                            }));
                        } catch (_) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            return res.end(JSON.stringify({ models: [DEFAULT_MODEL], default: DEFAULT_MODEL, status: 'ready' }));
                        }
                    });
                });

                tagsReq.on('error', () => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ models: [DEFAULT_MODEL], default: DEFAULT_MODEL, offline: true }));
                });

                tagsReq.end();
            });
        });

        psReq.on('error', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: [DEFAULT_MODEL], default: DEFAULT_MODEL, offline: true }));
        });

        psReq.end();
        return;
    }

    // ------------------------------------------------------------------------
    // ROUTE: Workspace File Tree
    // ------------------------------------------------------------------------
    if (req.method === 'GET' && pathname === '/api/workspace/tree') {
        try {
            const tree = getWorkspaceTree();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ tree, workspaceDir: WORKSPACE_DIR }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // ------------------------------------------------------------------------
    // ROUTE: Read Workspace File Content
    // ------------------------------------------------------------------------
    if (req.method === 'GET' && pathname === '/api/workspace/file') {
        const filePathParam = parsedUrl.searchParams.get('path');
        if (!filePathParam) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: "Missing 'path' query parameter" }));
        }
        try {
            const fullPath = resolveWorkspacePath(filePathParam);
            if (!fs.existsSync(fullPath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: `File '${filePathParam}' not found` }));
            }
            const content = fs.readFileSync(fullPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ path: filePathParam, content }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // ------------------------------------------------------------------------
    // ROUTE: Save Workspace File Content (Manual Edit)
    // ------------------------------------------------------------------------
    if (req.method === 'POST' && pathname === '/api/workspace/file') {
        try {
            const { path: filePathParam, content } = await readJSONBody();
            if (!filePathParam) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Missing 'path'" }));
            }
            const fullPath = resolveWorkspacePath(filePathParam);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            fs.writeFileSync(fullPath, content !== undefined ? content : '', 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, path: filePathParam }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // ------------------------------------------------------------------------
    // ROUTE: Create File or Folder
    // ------------------------------------------------------------------------
    if (req.method === 'POST' && pathname === '/api/workspace/create') {
        try {
            const { path: filePathParam, type } = await readJSONBody();
            if (!filePathParam) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Missing 'path'" }));
            }
            const fullPath = resolveWorkspacePath(filePathParam);
            if (type === 'dir') {
                fs.mkdirSync(fullPath, { recursive: true });
            } else {
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                if (!fs.existsSync(fullPath)) fs.writeFileSync(fullPath, '', 'utf8');
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, path: filePathParam }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // ------------------------------------------------------------------------
    // ROUTE: Delete File or Folder
    // ------------------------------------------------------------------------
    if (req.method === 'POST' && pathname === '/api/workspace/delete') {
        try {
            const { path: filePathParam } = await readJSONBody();
            if (!filePathParam) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Missing 'path'" }));
            }
            const fullPath = resolveWorkspacePath(filePathParam);
            if (fs.existsSync(fullPath)) {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    fs.rmSync(fullPath, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(fullPath);
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, path: filePathParam }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // ------------------------------------------------------------------------
    // ROUTE: Import Folder / Multiple Files into ./workspace
    // ------------------------------------------------------------------------
    if (req.method === 'POST' && pathname === '/api/workspace/import-folder') {
        try {
            const { files, clearExisting = false } = await readJSONBody();
            if (!Array.isArray(files) || files.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Missing or empty 'files' list in import payload" }));
            }

            if (clearExisting) {
                const existing = fs.readdirSync(WORKSPACE_DIR);
                for (const item of existing) {
                    fs.rmSync(path.join(WORKSPACE_DIR, item), { recursive: true, force: true });
                }
            }

            let importedCount = 0;
            const importedPaths = [];

            for (const file of files) {
                if (!file.path) continue;
                // STRICT WORKSPACE ISOLATION: verify path never escapes WORKSPACE_DIR
                const fullPath = resolveWorkspacePath(file.path);
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                if (file.isBase64 && file.content) {
                    fs.writeFileSync(fullPath, Buffer.from(file.content, 'base64'));
                } else {
                    fs.writeFileSync(fullPath, file.content !== undefined ? String(file.content) : '', 'utf8');
                }
                importedCount++;
                importedPaths.push(file.path);
            }

            const tree = getWorkspaceTree();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                success: true,
                message: `Successfully imported ${importedCount} file(s) into ./workspace`,
                count: importedCount,
                tree
            }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // ------------------------------------------------------------------------
    // ROUTE: Clear Entire Workspace
    // ------------------------------------------------------------------------
    if (req.method === 'POST' && pathname === '/api/workspace/clear') {
        try {
            const existing = fs.readdirSync(WORKSPACE_DIR);
            for (const item of existing) {
                fs.rmSync(path.join(WORKSPACE_DIR, item), { recursive: true, force: true });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, message: 'Workspace cleared successfully.' }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // ------------------------------------------------------------------------
    // ROUTE: Manual Terminal Execution (Bottom Terminal Bar)
    // ------------------------------------------------------------------------
    if (req.method === 'POST' && pathname === '/api/workspace/terminal') {
        try {
            const { command } = await readJSONBody();
            if (!command || !command.trim()) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Missing 'command'" }));
            }

            exec(command.trim(), {
                cwd: WORKSPACE_DIR,
                timeout: 30000,
                maxBuffer: 1024 * 1024 * 2
            }, (error, stdout, stderr) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    exitCode: error ? (error.code || 1) : 0,
                    stdout: stdout ? stdout.toString() : '',
                    stderr: stderr ? stderr.toString() : ''
                }));
            });
            return;
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // ------------------------------------------------------------------------
    // ROUTE: Autonomous Agent Real-Time SSE Stream (/api/agent/run)
    // ------------------------------------------------------------------------
    if (req.method === 'POST' && pathname === '/api/agent/run') {
        try {
            const { task, mode = 'full_auto', model = DEFAULT_MODEL, maxSteps = MAX_STEPS } = await readJSONBody();
            if (!task || !task.trim()) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Missing 'task' prompt" }));
            }

            // Abort previous session if still running
            if (activeSession) {
                activeSession.aborted = true;
                activeSession.abortController.abort();
                if (activeSession.currentChildProcess) {
                    try { activeSession.currentChildProcess.kill(); } catch (e) {}
                }
            }

            const sessionId = 'session_' + Date.now();
            const abortController = new AbortController();

            const sessionState = {
                id: sessionId,
                aborted: false,
                abortController,
                isWaitingApproval: false,
                approvalResolver: null,
                currentChildProcess: null
            };

            activeSession = sessionState;

            // Setup Server-Sent Events headers
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });

            const sendSSE = (eventObj) => {
                try {
                    res.write(`data: ${JSON.stringify(eventObj)}\n\n`);
                } catch (e) {}
            };

            req.on('close', () => {
                sessionState.aborted = true;
                sessionState.abortController.abort();
                if (sessionState.currentChildProcess) {
                    try { sessionState.currentChildProcess.kill(); } catch (e) {}
                }
            });

            // 1. Check if conversational chat (e.g. "hi", "hello", "who are you")
            if (isConversational(task)) {
                sendSSE({
                    type: 'chat_start',
                    sessionId,
                    task: task.trim()
                });

                const systemPrompt = `You are Vyom, an intelligent autonomous AI coding assistant powered by local Ollama models.
                                        You work inside a project IDE connected to a workspace (./workspace).
                                        You can create, edit, patch, and delete files, as well as run terminal commands and tests autonomously.
                                        Answer the user's conversational message politely, helpfully, and concisely. Mention that you are ready to create files, write code, or execute commands in the workspace whenever they give a coding task.`;

                try {
                    await callOllamaStream(
                        model,
                        task.trim(),
                        systemPrompt,
                        sessionState.abortController.signal,
                        (chunk) => {
                            sendSSE({ type: 'chat_chunk', text: chunk });
                        }
                    );
                    sendSSE({ type: 'chat_done' });
                } catch (err) {
                    // Friendly fallback message if Ollama is not yet warm or error occurs
                    sendSSE({
                        type: 'chat_chunk',
                        text: `Hello! I am Vyom, your autonomous coding assistant. I am ready to inspect, write, test, and run code in your workspace. What would you like to build or work on today?`
                    });
                    sendSSE({ type: 'chat_done' });
                }

                res.end();
                return;
            }

            // 2. Run the Autonomous ReAct loop for coding missions
            await runAutonomousAgentLoop({
                sessionId,
                userTask: task.trim(),
                mode,
                model,
                maxSteps: parseInt(maxSteps, 10) || MAX_STEPS,
                sendSSE,
                sessionState
            });

            res.end();
            return;
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // ------------------------------------------------------------------------
    // ROUTE: Semi-Auto Approval Endpoint (/api/agent/approve)
    // ------------------------------------------------------------------------
    if (req.method === 'POST' && pathname === '/api/agent/approve') {
        try {
            const { approved = true, reason = '' } = await readJSONBody();
            if (activeSession && activeSession.isWaitingApproval && activeSession.approvalResolver) {
                activeSession.approvalResolver({ approved: Boolean(approved), reason });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, message: 'Approval resolved' }));
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'No agent session is currently awaiting approval' }));
            }
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // ------------------------------------------------------------------------
    // ROUTE: Stop / Abort Agent Execution (/api/agent/stop)
    // ------------------------------------------------------------------------
    if (req.method === 'POST' && pathname === '/api/agent/stop') {
        if (activeSession) {
            activeSession.aborted = true;
            activeSession.abortController.abort();
            if (activeSession.currentChildProcess) {
                try { activeSession.currentChildProcess.kill(); } catch (e) {}
            }
            if (activeSession.isWaitingApproval && activeSession.approvalResolver) {
                activeSession.approvalResolver({ approved: false, reason: 'Session stopped by user' });
            }
            activeSession = null;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, message: 'Agent stopped' }));
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, message: 'No active agent session' }));
        }
    }

    // ------------------------------------------------------------------------
    // ROUTE: Agent Status
    // ------------------------------------------------------------------------
    if (req.method === 'GET' && pathname === '/api/agent/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            isRunning: Boolean(activeSession && !activeSession.aborted),
            isWaitingApproval: Boolean(activeSession && activeSession.isWaitingApproval)
        }));
    }

    // 404 Fallback
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

// ============================================================================
// 7. START SERVER
// ============================================================================
server.listen(PORT, () => {
    console.log('================================================================');
    console.log(`Vyom Autonomous Coding Agent IDE Running at: http://localhost:${PORT}`);
    console.log(`Sandboxed Workspace: ${WORKSPACE_DIR}`);
    console.log(`Default Ollama Model: ${DEFAULT_MODEL}`);
    console.log('================================================================');
});

