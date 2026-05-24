// lyte.js
// First working Lyte.js runtime + very simple parser.
// Supports: state{}, ui{}, group, row, text, button, input, list, when, divider,
// bind, on click, basic todos + counter patterns.

(function () {
  // ---------- Utilities ----------
  function trimLines(str) {
    return str
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0);
  }

  function parseValue(raw) {
    raw = raw.trim();
    if (raw === "[]" || raw === "[ ]") return [];
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if ((raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1);
    }
    // fallback: string
    return raw;
  }

  // ---------- Very simple Lyte parser ----------
  function parseLyteText(text) {
    // Extract inside <<lyte App ... >>
    const start = text.indexOf("<<lyte");
    const end = text.lastIndexOf(">>");
    if (start === -1 || end === -1) {
      throw new Error("Lyte: missing <<lyte ... >> block");
    }
    let inner = text.slice(start, end + 2);
    inner = inner.replace(/^<<lyte[^\n]*\n?/, "");
    inner = inner.replace(/>>\s*$/, "");

    const lines = trimLines(inner);

    const stateLines = [];
    const uiLines = [];
    let mode = null;
    let braceDepth = 0;

    for (let line of lines) {
      if (line.startsWith("state")) {
        mode = "state";
        braceDepth = 0;
        continue;
      }
      if (line.startsWith("ui")) {
        mode = "ui";
        braceDepth = 0;
        continue;
      }
      if (mode === "state") {
        if (line.includes("{")) braceDepth++;
        if (line.includes("}")) {
          braceDepth--;
          if (braceDepth < 0) {
            mode = null;
            continue;
          }
        }
        if (!line.startsWith("{") && !line.startsWith("}")) {
          stateLines.push(line);
        }
      } else if (mode === "ui") {
        uiLines.push(line);
      }
    }

    const state = parseStateBlock(stateLines);
    const ui = parseUiBlock(uiLines);

    return { state, ui };
  }

  function parseStateBlock(lines) {
    const state = {};
    for (let line of lines) {
      if (!line || line === "}" || line === "{") continue;
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) continue;
      const key = line.slice(0, eqIndex).trim();
      const valueRaw = line.slice(eqIndex + 1).trim();
      state[key] = parseValue(valueRaw);
    }
    return state;
  }

  // Very simple UI parser: line-based, indentation via braces.
  function parseUiBlock(lines) {
    const root = { type: "root", children: [] };
    const stack = [root];

    function current() {
      return stack[stack.length - 1];
    }

    for (let raw of lines) {
      let line = raw.trim();
      if (!line) continue;

      if (line === "{" || line === "}") continue;

      if (line.endsWith("{")) {
        const header = line.slice(0, -1).trim();
        const node = parseUiHeader(header);
        node.children = [];
        current().children.push(node);
        stack.push(node);
        continue;
      }

      if (line === "}") {
        stack.pop();
        continue;
      }

      if (line === "divider") {
        current().children.push({ type: "divider" });
        continue;
      }

      // Single-line elements (e.g. text "Count:")
      const node = parseUiHeader(line);
      if (node) {
        current().children.push(node);
      }
    }

    return root;
  }

  function parseUiHeader(header) {
    // group Name
    if (header.startsWith("group ")) {
      const name = header.slice("group ".length).trim();
      return { type: "group", name, children: [] };
    }

    if (header === "row") {
      return { type: "row", children: [] };
    }

    // text "literal"
    if (header.startsWith("text ")) {
      const rest = header.slice("text ".length).trim();
      if (rest.startsWith("bind ")) {
        const bind = rest.slice("bind ".length).trim();
        return { type: "text", bind };
      }
      if (rest.startsWith("error")) {
        return { type: "text", bind: "error", className: "lyte-error" };
      }
      const match = rest.match(/^"([^"]*)"/);
      if (match) {
        return { type: "text", value: match[1] };
      }
    }

    // button "Label" on click { ... }
    if (header.startsWith("button ")) {
      const btn = { type: "button", label: "" };
      const labelMatch = header.match(/button\s+"([^"]*)"/);
      if (labelMatch) {
        btn.label = labelMatch[1];
      }
      if (header.includes("on click")) {
        const bodyMatch = header.match(/on click\s*{([\s\S]*)}$/);
        if (bodyMatch) {
          const body = bodyMatch[1].trim();
          btn._onClickBody = body;
        }
      }
      return btn;
    }

    // input id placeholder "..."
    if (header.startsWith("input ")) {
      const parts = header.split(/\s+/);
      const id = parts[1];
      let placeholder = "";
      const phMatch = header.match(/placeholder\s+"([^"]*)"/);
      if (phMatch) placeholder = phMatch[1];
      return { type: "input", id, placeholder };
    }

    // list todos as todo filtered by filter {
    if (header.startsWith("list ")) {
      const m = header.match(/^list\s+(\w+)\s+as\s+(\w+)(?:\s+filtered\s+by\s+(\w+))?/);
      if (m) {
        return {
          type: "list",
          source: m[1],
          as: m[2],
          filterKey: m[3] || null,
          children: []
        };
      }
    }

    // when todos is empty {
    if (header.startsWith("when ")) {
      const m = header.match(/^when\s+(\w+)\s+is\s+empty/);
      if (m) {
        return {
          type: "when-empty",
          source: m[1],
          children: []
        };
      }
    }

    return null;
  }

  // ---------- Runtime / Renderer ----------
  function createLyteApp(rootElement, spec) {
    const state = structuredClone(spec.state || {});
    const ctx = {
      inputs: {},
      root: rootElement
    };

    function now() {
      return Date.now();
    }

    function trimStr(s) {
      return (s || "").trim();
    }

    function getFiltered(sourceName, filterKey) {
      const arr = state[sourceName] || [];
      if (!filterKey || sourceName !== "todos") return arr;
      if (state.filter === "active") {
        return arr.filter(t => !t.completed);
      }
      if (state.filter === "completed") {
        return arr.filter(t => t.completed);
      }
      return arr;
    }

    function evalClickBody(body, item) {
      // Very tiny, very limited "interpreter" for on click bodies.
      // Supports patterns used in your example only.
      // Example bodies:
      //   Count = Count + 1
      //   filter = "all"
      //   if trim(todoInput) == "" { ... } else { ... }
      //   todos.append({ id: now(), text: todoInput, completed: false })
      //   todos.remove(todo.id)

      const s = state;
      const helpers = {
        now,
        trim: trimStr
      };

      function getVar(name) {
        if (name in s) return s[name];
        if (name === "todo" && item) return item;
        if (ctx.inputs[name]) return ctx.inputs[name].value;
        return undefined;
      }

      function setVar(name, value) {
        if (name in s) {
          s[name] = value;
        } else if (ctx.inputs[name]) {
          ctx.inputs[name].value = value;
        }
      }

      function appendTo(name, obj) {
        if (!Array.isArray(s[name])) s[name] = [];
        s[name].push(obj);
      }

      function removeFromTodosById(id) {
        s.todos = (s.todos || []).filter(t => t.id !== id);
      }

      // Very crude parsing:
      const trimmed = body.trim();

      // if ... else ...
      if (trimmed.startsWith("if ")) {
        // if trim(todoInput) == "" { ... } else { ... }
        const ifMatch = trimmed.match(/^if\s+(.+?)\s*==\s*""\s*{([\s\S]*?)}\s*else\s*{([\s\S]*?)}$/);
        if (ifMatch) {
          const condExpr = ifMatch[1].trim();
          const thenBody = ifMatch[2].trim();
          const elseBody = ifMatch[3].trim();

          // Only support trim(x)
          const condTrimMatch = condExpr.match(/^trim\((\w+)\)$/);
          if (condTrimMatch) {
            const varName = condTrimMatch[1];
            const val = trimStr(getVar(varName));
            if (val === "") {
              evalClickBody(thenBody, item);
            } else {
              evalClickBody(elseBody, item);
            }
            return;
          }
        }
      }

      // assignment: X = X + 1  OR  filter = "all"
      const assignMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
      if (assignMatch) {
        const left = assignMatch[1];
        const right = assignMatch[2].trim();

        // pattern: Count = Count + 1
        const plusMatch = right.match(/^(\w+)\s*\+\s*(\d+)$/);
        if (plusMatch) {
          const varName = plusMatch[1];
          const num = Number(plusMatch[2]);
          const current = getVar(varName) || 0;
          setVar(left, current + num);
          return;
        }

        // string literal
        if ((right.startsWith('"') && right.endsWith('"')) ||
            (right.startsWith("'") && right.endsWith("'"))) {
          setVar(left, right.slice(1, -1));
          return;
        }

        // direct variable
        if (/^\w+$/.test(right)) {
          setVar(left, getVar(right));
          return;
        }
      }

      // todos.append({ ... })
      const appendMatch = trimmed.match(/^todos\.append\(\{\s*id:\s*now\(\),\s*text:\s*(\w+),\s*completed:\s*false\s*\}\s*\)$/);
      if (appendMatch) {
        const textVar = appendMatch[1];
        appendTo("todos", {
          id: now(),
          text: getVar(textVar),
          completed: false
        });
        return;
      }

      // todos.remove(todo.id)
      const removeMatch = trimmed.match(/^todos\.remove\(todo\.id\)$/);
      if (removeMatch && item) {
        removeFromTodosById(item.id);
        return;
      }
    }

    function render() {
      rootElement.innerHTML = "";
      const tree = renderNode(spec.ui, null);
      if (tree) rootElement.appendChild(tree);
    }

    function renderNode(node, item) {
      if (!node) return null;

      switch (node.type) {
        case "root": {
          const div = document.createElement("div");
          (node.children || []).forEach(child => {
            const el = renderNode(child, null);
            if (el) div.appendChild(el);
          });
          return div;
        }

        case "group": {
          const div = document.createElement("div");
          div.className = "lyte-group";
          if (node.name) {
            const title = document.createElement("h3");
            title.textContent = node.name;
            div.appendChild(title);
          }
          (node.children || []).forEach(child => {
            const el = renderNode(child, null);
            if (el) div.appendChild(el);
          });
          return div;
        }

        case "row": {
          const div = document.createElement("div");
          div.className = "lyte-row";
          (node.children || []).forEach(child => {
            const el = renderNode(child, item);
            if (el) div.appendChild(el);
          });
          return div;
        }

        case "text": {
          const span = document.createElement("span");
          if (node.bind) {
            span.textContent = state[node.bind];
          } else if (node.bindItem && item) {
            span.textContent = item[node.bindItem] ?? "";
          } else {
            span.textContent = node.value ?? "";
          }
          if (node.className) span.className = node.className;
          if (node.styleWhen && item) {
            Object.assign(span.style, node.styleWhen(item));
          }
          return span;
        }

        case "button": {
          const btn = document.createElement("button");
          btn.textContent = node.label || "";
          btn.onclick = () => {
            if (node._onClickBody) {
              evalClickBody(node._onClickBody, item);
            }
            render();
          };
          return btn;
        }

        case "input": {
          const input = document.createElement("input");
          input.type = "text";
          if (node.placeholder) input.placeholder = node.placeholder;
          if (node.id) ctx.inputs[node.id] = input;
          return input;
        }

        case "checkbox": {
          const cb = document.createElement("input");
          cb.type = "checkbox";
          if (node.bindItem && item) {
            cb.checked = !!item[node.bindItem];
            cb.onchange = () => {
              item[node.bindItem] = cb.checked;
              render();
            };
          }
          return cb;
        }

        case "divider": {
          return document.createElement("hr");
        }

        case "list": {
          const container = document.createElement("div");
          container.className = "lyte-list";

          const items = getFiltered(node.source, node.filterKey);

          if (!items.length) {
            // look for when-empty sibling
            const whenEmpty = (spec.ui.children || [])
              .filter(c => c.type === "when-empty" && c.source === node.source)[0];
            if (whenEmpty) {
              (whenEmpty.children || []).forEach(child => {
                const el = renderNode(child, null);
                if (el) container.appendChild(el);
              });
            }
            return container;
          }

          items.forEach(it => {
            (node.children || []).forEach(child => {
              const el = renderNode(child, it);
              if (el) container.appendChild(el);
            });
          });

          return container;
        }

        case "when-empty": {
          // handled in list
          return null;
        }

        default:
          return null;
      }
    }

    render();
    return { state, rerender: render };
  }

  // ---------- Auto-bootstrap from <script type="text/lyte"> ----------
  function bootstrapLyteScripts() {
    const scripts = document.querySelectorAll('script[type="text/lyte"]');
    scripts.forEach(script => {
      const targetId = script.getAttribute("data-target") || "app";
      const target = document.getElementById(targetId);
      if (!target) return;
      const code = script.textContent || "";
      const spec = parseLyteText(code);
      createLyteApp(target, spec);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrapLyteScripts);
  } else {
    bootstrapLyteScripts();
  }

  // Expose globally
  window.Lyte = {
    parse: parseLyteText,
    createApp: createLyteApp
  };
})();
