// In-page helper. Evaluated (idempotently) before every helper call, so it must stay a plain
// self-contained script: no imports, no TypeScript.
(() => {
	const VERSION = "__LIXB_VERSION__"; // replaced with a hash of this file when loaded
	if (window.__lixb && window.__lixb.v === VERSION) return;

	const INTERACTIVE = [
		"a[href]",
		"button",
		"input:not([type=hidden])",
		"select",
		"textarea",
		"summary",
		"[contenteditable='']",
		"[contenteditable=true]",
		"[role=button]",
		"[role=link]",
		"[role=checkbox]",
		"[role=radio]",
		"[role=switch]",
		"[role=tab]",
		"[role=menuitem]",
		"[role=option]",
		"[role=combobox]",
		"[role=textbox]",
		"[role=searchbox]",
		"[onclick]",
		"[tabindex]:not([tabindex='-1'])",
	].join(",");
	const ROLE_SCAN = `${INTERACTIVE},[role],img,h1,h2,h3,h4,h5,h6`;
	const EDITABLE =
		"input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=file]),textarea,select,[contenteditable=''],[contenteditable=true],[role=textbox],[role=searchbox]";
	const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
	// Tags that sites commonly turn into buttons with a click handler and cursor:pointer.
	const POINTER_TAGS = "div,span,li,label,td,p,img,svg,i";

	const refs = new Map();
	const ids = new WeakMap();
	const meta = new Map(); // ref → {tag, role, name}, to find the element again after a re-render
	let nextRef = 1;

	const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

	function refOf(el) {
		let id = ids.get(el);
		if (!id) {
			id = `e${nextRef++}`;
			ids.set(el, id);
			refs.set(id, el);
		}
		return id;
	}

	function remember(el, role, name) {
		const ref = refOf(el);
		meta.set(ref, { tag: el.tagName, role, name });
		return ref;
	}

	// Frameworks often replace nodes on re-render; rebind the ref if exactly one equivalent element exists.
	function get(ref) {
		const el = refs.get(ref);
		if (el && el.isConnected) return el;
		const m = meta.get(ref);
		if (m) {
			const twins = [...document.getElementsByTagName(m.tag)].filter(
				(c) =>
					roleOf(c) === m.role &&
					nameOf(c).slice(0, 120) === m.name &&
					isVisible(c),
			);
			if (twins.length === 1) {
				refs.set(ref, twins[0]);
				return twins[0];
			}
		}
		const what = m ? ` (${m.role} "${m.name.slice(0, 60)}")` : "";
		throw new Error(
			`Element ${ref}${what} is gone (page changed); find it again`,
		);
	}

	// The outermost element of a cursor:pointer region that isn't a real control: a div acting as a button.
	function isPointerRoot(el) {
		if (
			el.matches(INTERACTIVE) ||
			el.closest(
				"a[href],button,[role=button],[role=link],[role=option],[role=menuitem],[role=tab]",
			)
		)
			return false;
		if (getComputedStyle(el).cursor !== "pointer") return false;
		const parent = el.parentElement;
		return !parent || getComputedStyle(parent).cursor !== "pointer";
	}

	function clickableOf(el) {
		for (
			let node = el, depth = 0;
			node && node !== document.body && depth < 6;
			node = node.parentElement, depth++
		) {
			if (node.matches(INTERACTIVE) || isPointerRoot(node)) return node;
		}
		return null;
	}

	function pointerRoots(root, onlyInView) {
		return [...root.querySelectorAll(POINTER_TAGS)].filter(
			(el) => (!onlyInView || inViewport(el)) && isPointerRoot(el),
		);
	}

	// A heading or bare label stands for the section it titles: climb to the nearest ancestor that also
	// holds controls, so within:'Review score' searches the filters under that heading.
	function sectionOf(el) {
		const isLeaf =
			/^H[1-6]$/.test(el.tagName) ||
			el.getAttribute("role") === "heading" ||
			el.children.length === 0 ||
			!el.querySelector(`${INTERACTIVE},${POINTER_TAGS}`);
		if (!isLeaf) return el;
		for (
			let node = el.parentElement, depth = 0;
			node && node !== document.body && depth < 6;
			node = node.parentElement, depth++
		) {
			const controls = [...node.querySelectorAll(INTERACTIVE)].filter(
				(c) => !c.contains(el) && !el.contains(c),
			);
			if (controls.length) return node;
		}
		return el;
	}

	const byDocumentOrder = (a, b) =>
		a === b
			? 0
			: a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
				? -1
				: 1;

	function roleOf(el) {
		const explicit = el.getAttribute("role");
		if (explicit) return explicit.split(" ")[0];
		const tag = el.tagName.toLowerCase();
		if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
		if (tag === "button" || tag === "summary") return "button";
		if (tag === "select") return "combobox";
		if (tag === "textarea") return "textbox";
		if (tag === "img") return "img";
		if (/^h[1-6]$/.test(tag)) return "heading";
		if (tag === "input") {
			const type = (el.type || "text").toLowerCase();
			if (["button", "submit", "reset", "image"].includes(type))
				return "button";
			if (type === "checkbox") return "checkbox";
			if (type === "radio") return "radio";
			if (type === "range") return "slider";
			if (type === "search") return "searchbox";
			return "textbox";
		}
		if (el.isContentEditable) return "textbox";
		if (
			[
				"DIV",
				"SPAN",
				"LI",
				"LABEL",
				"TD",
				"P",
				"IMG",
				"SVG",
				"I",
			].includes(el.tagName.toUpperCase()) &&
			isPointerRoot(el)
		)
			return "button";
		return "generic";
	}

	function nameOf(el) {
		const aria = el.getAttribute("aria-label");
		if (aria) return norm(aria);
		const labelledBy = el.getAttribute("aria-labelledby");
		if (labelledBy) {
			const text = norm(
				labelledBy
					.split(/\s+/)
					.map((id) => document.getElementById(id)?.innerText ?? "")
					.join(" "),
			);
			if (text) return text;
		}
		const tag = el.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
			if (["button", "submit", "reset"].includes(el.type))
				return norm(el.value);
			const label = el.labels?.[0]?.innerText;
			if (label) return norm(label);
			return norm(
				el.placeholder || el.getAttribute("title") || el.name || "",
			);
		}
		if (tag === "IMG")
			return norm(el.alt || el.getAttribute("title") || "");
		return (
			norm(el.innerText ?? el.textContent) ||
			norm(el.getAttribute("title") || "")
		);
	}

	function isVisible(el) {
		if (
			el.checkVisibility &&
			!el.checkVisibility({
				opacityProperty: true,
				visibilityProperty: true,
			})
		)
			return false;
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	}

	function inViewport(el) {
		const r = el.getBoundingClientRect();
		return (
			r.bottom > 0 &&
			r.right > 0 &&
			r.top < innerHeight &&
			r.left < innerWidth
		);
	}

	function matcher(m, exact) {
		if (m == null) return null;
		if (typeof m === "object") {
			const re = new RegExp(m.re, m.flags);
			return (s) => {
				re.lastIndex = 0;
				return re.test(s);
			};
		}
		const needle = norm(String(m)).toLowerCase();
		return exact
			? (s) => s.toLowerCase() === needle
			: (s) => s.toLowerCase().includes(needle);
	}

	// Smallest elements whose visible text matches, plus elements whose label-ish attributes match.
	function byText(test, root) {
		const found = new Set();
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const parent = node.parentElement;
			if (!parent || SKIP.has(parent.tagName)) continue;
			if (test(norm(node.nodeValue))) found.add(parent);
		}
		for (const el of root.querySelectorAll(
			"[aria-label],[placeholder],[title],img[alt],input[type=button],input[type=submit],input[type=reset]",
		)) {
			if (test(nameOf(el))) found.add(el);
		}
		if (found.size) return [...found];

		// Text split over several nodes ("Total: <b>5</b>"): take the deepest elements that match.
		const hits = new Set(
			[...root.querySelectorAll("*")].filter(
				(el) => !SKIP.has(el.tagName) && test(norm(el.textContent)),
			),
		);
		return [...hits].filter(
			(el) => ![...el.children].some((child) => hits.has(child)),
		);
	}

	function gap(a, r) {
		const dx = Math.max(0, r.left - a.right, a.left - r.right);
		const dy = Math.max(0, r.top - a.bottom, a.top - r.bottom);
		return Math.hypot(dx, dy);
	}

	function inDirection(a, r, direction) {
		if (direction === "right") return r.left >= a.right - 4;
		if (direction === "left") return r.right <= a.left + 4;
		if (direction === "below") return r.top >= a.bottom - 4;
		if (direction === "above") return r.bottom <= a.top + 4;
		return true;
	}

	// Elements sharing a row or column with the anchor rank first, then by edge distance.
	function rank(a, els, direction) {
		return els
			.map((el) => ({ el, r: el.getBoundingClientRect() }))
			.filter(({ r }) => inDirection(a, r, direction))
			.map(({ el, r }) => {
				const aligned =
					(r.top < a.bottom && r.bottom > a.top) ||
					(r.left < a.right && r.right > a.left);
				return { el, tier: aligned ? 0 : 1, d: gap(a, r) };
			})
			.sort((x, y) => x.tier - y.tier || x.d - y.d)
			.map((x) => x.el);
	}

	function resolve(spec) {
		if (spec.ref) return [get(spec.ref)];

		let root = document.body;
		if (spec.within) {
			const [within] = resolve(spec.within);
			if (!within) return [];
			root = sectionOf(within);
		}

		const test = matcher(spec.text, spec.exact);
		let list;
		if (spec.selector) {
			list = [...root.querySelectorAll(spec.selector)];
			if (test) list = list.filter((el) => test(nameOf(el)));
		} else if (spec.role) {
			const candidates = new Set(root.querySelectorAll(ROLE_SCAN));
			// Buttons are often divs with a click handler; find them through their text.
			if (spec.role === "button") {
				const extra = test
					? byText(test, root).map(clickableOf).filter(Boolean)
					: pointerRoots(root, false);
				for (const el of extra) candidates.add(el);
			}
			list = [...candidates].filter((el) => roleOf(el) === spec.role);
			if (test) list = list.filter((el) => test(nameOf(el)));
			list.sort(byDocumentOrder);
		} else if (test) {
			list = byText(test, root);
		} else {
			list = [...root.querySelectorAll(INTERACTIVE)];
		}

		if (!spec.hidden) list = list.filter(isVisible);

		// Rank exact text matches first, then real controls over plain text that merely repeats the label.
		if (spec.text != null && list.length > 1) {
			const needle =
				typeof spec.text === "string" && !spec.exact
					? norm(spec.text).toLowerCase()
					: null;
			const exact = (el) =>
				needle && nameOf(el).toLowerCase() !== needle ? 1 : 0;
			const control = (el) =>
				roleOf(el) !== "generic" ? 0 : clickableOf(el) ? 1 : 2;
			list = list
				.map((el, i) => ({ el, i, e: exact(el), c: control(el) }))
				.sort((a, b) => a.e - b.e || a.c - b.c || a.i - b.i)
				.map((x) => x.el);
		}

		if (spec.near) {
			const [anchor] = resolve(spec.near);
			if (!anchor) return [];
			const candidates = list.filter(
				(el) => el !== anchor && !el.contains(anchor),
			);
			list = rank(
				anchor.getBoundingClientRect(),
				candidates,
				spec.direction,
			);
		}

		return list;
	}

	function describe(el) {
		const r = el.getBoundingClientRect();
		const role = roleOf(el);
		const name = nameOf(el).slice(0, 120);
		return {
			ref: remember(el, role, name),
			role,
			name,
			tag: el.tagName.toLowerCase(),
			rect: {
				x: Math.round(r.x),
				y: Math.round(r.y),
				w: Math.round(r.width),
				h: Math.round(r.height),
			},
		};
	}

	function deepElementFromPoint(x, y) {
		let hit = document.elementFromPoint(x, y);
		while (hit && hit.shadowRoot) {
			const inner = hit.shadowRoot.elementFromPoint(x, y);
			if (!inner || inner === hit) break;
			hit = inner;
		}
		return hit;
	}

	function containsComposed(el, node) {
		for (let n = node; n; n = n.parentNode || n.host) {
			if (n === el) return true;
		}
		return false;
	}

	function editableFor(el) {
		if (el.matches(EDITABLE) || el.isContentEditable) return el;
		if (el.tagName === "LABEL" && el.control) return el.control;
		const label = el.closest("label");
		if (label && label.control) return label.control;
		const inner = [...el.querySelectorAll(EDITABLE)].find(isVisible);
		if (inner) return inner;
		const fields = [...document.querySelectorAll(EDITABLE)].filter(
			isVisible,
		);
		return rank(el.getBoundingClientRect(), fields)[0] ?? null;
	}

	function controlLine(el) {
		const role = roleOf(el);
		const name = nameOf(el);
		let line = `${remember(el, role, name.slice(0, 120))} ${role} "${name.slice(0, 100)}${name.length > 100 ? "…" : ""}"`;
		if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
			if (el.type === "checkbox" || el.type === "radio")
				line += el.checked ? " [checked]" : " [unchecked]";
			else if (el.value)
				line +=
					el.type === "password"
						? ' = "•••"'
						: ` = "${el.value.slice(0, 40)}"`;
		}
		if (el.tagName === "SELECT")
			line += ` = "${norm(el.selectedOptions[0]?.textContent).slice(0, 40)}"`;
		if (el.getAttribute("aria-checked"))
			line += ` [${el.getAttribute("aria-checked") === "true" ? "checked" : "unchecked"}]`;
		if (el.getAttribute("aria-expanded"))
			line +=
				el.getAttribute("aria-expanded") === "true"
					? " [expanded]"
					: " [collapsed]";
		if (el.disabled || el.getAttribute("aria-disabled") === "true")
			line += " [disabled]";
		if (role === "link") {
			const href = el.getAttribute("href") || "";
			if (href && !href.startsWith("javascript:"))
				line += ` → ${href.slice(0, 80)}`;
		}
		return line;
	}

	function deepActive() {
		let active = document.activeElement;
		while (active && active.shadowRoot && active.shadowRoot.activeElement)
			active = active.shadowRoot.activeElement;
		return active;
	}

	function mouseInit(x, y, button) {
		return {
			bubbles: true,
			cancelable: true,
			composed: true,
			view: window,
			clientX: x,
			clientY: y,
			screenX: x + screenX,
			screenY: y + screenY,
			button: { left: 0, middle: 1, right: 2 }[button] ?? 0,
		};
	}

	function hoverAt(x, y) {
		const target = deepElementFromPoint(x, y);
		if (!target)
			throw new Error(`Nothing at ${Math.round(x)},${Math.round(y)}`);
		const base = mouseInit(x, y, "left");
		const pointer = {
			...base,
			pointerId: 1,
			pointerType: "mouse",
			isPrimary: true,
		};
		target.dispatchEvent(new PointerEvent("pointerover", pointer));
		target.dispatchEvent(new MouseEvent("mouseover", base));
		target.dispatchEvent(new PointerEvent("pointermove", pointer));
		target.dispatchEvent(new MouseEvent("mousemove", base));
		return target;
	}

	window.__lixb = {
		v: VERSION,

		// ── fallback input (used when the debugger can't attach): synthetic, isTrusted=false ──

		synthHover(x, y) {
			return controlLine(hoverAt(x, y));
		},

		synthClick(x, y, button, count) {
			const target = hoverAt(x, y);
			const base = mouseInit(x, y, button);
			const pointer = {
				...base,
				pointerId: 1,
				pointerType: "mouse",
				isPrimary: true,
			};
			const buttons = { left: 1, middle: 4, right: 2 }[button] ?? 1;
			for (let detail = 1; detail <= count; detail++) {
				target.dispatchEvent(
					new PointerEvent("pointerdown", { ...pointer, buttons }),
				);
				const proceed = target.dispatchEvent(
					new MouseEvent("mousedown", { ...base, buttons, detail }),
				);
				if (proceed) {
					const focusable = target.closest(
						"input,textarea,select,button,a[href],[tabindex],[contenteditable]",
					);
					(focusable ?? target).focus?.({ preventScroll: true });
				}
				target.dispatchEvent(
					new PointerEvent("pointerup", { ...pointer, buttons: 0 }),
				);
				target.dispatchEvent(
					new MouseEvent("mouseup", { ...base, buttons: 0, detail }),
				);
				// A dispatched click still runs default actions: links navigate, checkboxes toggle, buttons submit.
				target.dispatchEvent(
					new MouseEvent(
						button === "right" ? "contextmenu" : "click",
						{ ...base, buttons: 0, detail },
					),
				);
			}
			if (count === 2 && button === "left")
				target.dispatchEvent(
					new MouseEvent("dblclick", { ...base, detail: 2 }),
				);
			return controlLine(target);
		},

		insertText(text) {
			const el = deepActive();
			if (!el || el === document.body)
				throw new Error("Nothing editable has focus");
			if (document.execCommand("insertText", false, text)) return true;
			if (!("value" in el))
				throw new Error("Focused element is not editable");

			// execCommand refused: set the value through the native setter so frameworks see it.
			const proto =
				el.tagName === "TEXTAREA"
					? HTMLTextAreaElement.prototype
					: HTMLInputElement.prototype;
			const start = el.selectionStart ?? el.value.length;
			const end = el.selectionEnd ?? el.value.length;
			Object.getOwnPropertyDescriptor(proto, "value").set.call(
				el,
				el.value.slice(0, start) + text + el.value.slice(end),
			);
			el.dispatchEvent(
				new InputEvent("input", {
					bubbles: true,
					inputType: "insertText",
					data: text,
				}),
			);
			el.dispatchEvent(new Event("change", { bubbles: true }));
			return true;
		},

		synthKey(key, code, keyCode, modifiers, command) {
			const el = deepActive() ?? document.body;
			const init = {
				key,
				code,
				keyCode,
				which: keyCode,
				bubbles: true,
				cancelable: true,
				composed: true,
				altKey: Boolean(modifiers & 1),
				ctrlKey: Boolean(modifiers & 2),
				metaKey: Boolean(modifiers & 4),
				shiftKey: Boolean(modifiers & 8),
			};
			const proceed = el.dispatchEvent(
				new KeyboardEvent("keydown", init),
			);
			// Synthetic key events have no default action, so perform the usual effect by hand.
			if (proceed) {
				if (command) document.execCommand(command);
				else if (key.length === 1 && !init.ctrlKey && !init.metaKey) {
					el.dispatchEvent(new KeyboardEvent("keypress", init));
					document.execCommand("insertText", false, key);
				} else if (key === "Backspace") document.execCommand("delete");
				else if (key === "Delete")
					document.execCommand("forwardDelete");
				else if (key === "Enter") {
					if (el.tagName === "TEXTAREA" || el.isContentEditable)
						document.execCommand("insertLineBreak");
					else if (el.tagName === "INPUT" && el.form)
						el.form.requestSubmit();
					else if (el.tagName === "BUTTON" || el.tagName === "A")
						el.click();
				}
			}
			el.dispatchEvent(new KeyboardEvent("keyup", init));
			return true;
		},

		viewRect(ref) {
			const el = get(ref);
			el.scrollIntoView({
				block: "center",
				inline: "center",
				behavior: "instant",
			});
			const r = el.getBoundingClientRect();
			const x = Math.max(0, r.x);
			const y = Math.max(0, r.y);
			return {
				x,
				y,
				w: Math.min(r.right, innerWidth) - x,
				h: Math.min(r.bottom, innerHeight) - y,
			};
		},

		find(spec, { limit = 20 } = {}) {
			const list = resolve(spec);
			const start = spec.nth ?? 0;
			return {
				total: list.length,
				items: list.slice(start, start + limit).map(describe),
			};
		},

		describe(ref) {
			return describe(get(ref));
		},

		// Closest candidates for a spec that matched nothing, for the error message.
		suggest(spec) {
			const needle =
				typeof spec.text === "string"
					? norm(spec.text).toLowerCase()
					: "";
			const words = needle
				.split(/[^\p{L}\p{N}]+/u)
				.filter((w) => w.length > 2);
			const hasWord = (name, word) =>
				new RegExp(
					`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
					"u",
				).test(name);
			const pool = new Set(
				[
					...document.body.querySelectorAll(
						`${INTERACTIVE},h1,h2,h3,h4,label`,
					),
				].filter(isVisible),
			);
			for (const el of pointerRoots(document.body, true)) pool.add(el);
			const scored = [...pool].map((el) => {
				const name = nameOf(el).toLowerCase();
				let score = words.filter((w) => hasWord(name, w)).length;
				if (needle && name.includes(needle)) score += 3;
				if (spec.role && roleOf(el) === spec.role) score += 1;
				return { el, score };
			});
			return scored
				.filter((x) => x.score > (spec.role && needle ? 1 : 0))
				.sort((a, b) => b.score - a.score)
				.slice(0, 4)
				.map((x) => controlLine(x.el));
		},

		readAll(spec, limit, max, where) {
			const test = where ? matcher(where, false) : null;
			return resolve(spec)
				.map((el) => ({
					el,
					text: (el.innerText ?? el.textContent ?? "")
						.replace(/\n{2,}/g, "\n")
						.trim(),
				}))
				.filter(({ text }) => !test || test(text))
				.slice(0, limit)
				.map(({ el, text }) => ({
					ref: refOf(el),
					text: text.length > max ? `${text.slice(0, max)}…` : text,
				}));
		},

		// Count of DOM mutations since the observer was installed; the server polls it to tell when a page settles.
		mutations() {
			if (!window.__lixbMutations) {
				const counter = { n: 0 };
				new MutationObserver(
					(records) => (counter.n += records.length),
				).observe(document, {
					subtree: true,
					childList: true,
					attributes: true,
					characterData: true,
				});
				window.__lixbMutations = counter;
			}
			return [
				window.__lixbMutations.n,
				location.href,
				document.readyState,
			];
		},

		point(ref) {
			const el = get(ref);
			el.scrollIntoView({
				block: "center",
				inline: "center",
				behavior: "instant",
			});
			const r = el.getBoundingClientRect();
			const x = Math.min(
				Math.max(r.left + r.width / 2, 1),
				innerWidth - 1,
			);
			const y = Math.min(
				Math.max(r.top + r.height / 2, 1),
				innerHeight - 1,
			);
			const hit = deepElementFromPoint(x, y);
			const ok = hit && containsComposed(el, hit);
			return {
				x,
				y,
				covered: !ok,
				by: hit && !ok ? controlLine(hit) : null,
				url: location.href,
				hidden: document.visibilityState === "hidden",
			};
		},

		focusEditable(ref) {
			const field = editableFor(get(ref));
			if (!field) throw new Error(`No editable field at or near ${ref}`);
			field.scrollIntoView({ block: "center", behavior: "instant" });
			field.focus();
			if (field.tagName !== "SELECT") {
				if (typeof field.select === "function") field.select();
				else if (field.isContentEditable) {
					const range = document.createRange();
					range.selectNodeContents(field);
					const selection = getSelection();
					selection.removeAllRanges();
					selection.addRange(range);
				}
			}
			return describe(field);
		},

		selectOption(ref, value) {
			const el = get(ref);
			const select = el.tagName === "SELECT" ? el : editableFor(el);
			if (!select || select.tagName !== "SELECT")
				throw new Error(
					"Not a <select>; click it and then click the option instead",
				);
			const options = [...select.options];
			const wanted = norm(String(value)).toLowerCase();
			const option =
				options.find((o) => o.value === value) ??
				options.find(
					(o) => norm(o.textContent).toLowerCase() === wanted,
				) ??
				options.find((o) =>
					norm(o.textContent).toLowerCase().includes(wanted),
				);
			if (!option)
				throw new Error(
					`No option "${value}". Options: ${options.map((o) => norm(o.textContent)).join(", ")}`,
				);
			Object.getOwnPropertyDescriptor(
				HTMLSelectElement.prototype,
				"value",
			).set.call(select, option.value);
			select.dispatchEvent(new Event("input", { bubbles: true }));
			select.dispatchEvent(new Event("change", { bubbles: true }));
			return norm(option.textContent);
		},

		checked(ref) {
			const el = get(ref);
			if (typeof el.checked === "boolean") return el.checked;
			const inner = el.querySelector(
				"input[type=checkbox],input[type=radio]",
			);
			if (inner) return inner.checked;
			return el.getAttribute("aria-checked") === "true";
		},

		// Scrolls the scrollable container under the viewport centre (or around ref), else the window.
		scrollBy(dx, dy, ref) {
			let el = ref
				? get(ref)
				: deepElementFromPoint(innerWidth / 2, innerHeight / 2);
			for (
				;
				el && el !== document.body && el !== document.documentElement;
				el = el.parentElement
			) {
				const style = getComputedStyle(el);
				const canY =
					dy &&
					/(auto|scroll|overlay)/.test(style.overflowY) &&
					el.scrollHeight > el.clientHeight;
				const canX =
					dx &&
					/(auto|scroll|overlay)/.test(style.overflowX) &&
					el.scrollWidth > el.clientWidth;
				if (canY || canX) {
					el.scrollBy({ left: dx, top: dy, behavior: "instant" });
					return {
						container: controlLine(el),
						x: Math.round(el.scrollLeft),
						y: Math.round(el.scrollTop),
						height: el.scrollHeight,
					};
				}
			}
			window.scrollBy({ left: dx, top: dy, behavior: "instant" });
			return {
				container: "window",
				x: Math.round(scrollX),
				y: Math.round(scrollY),
				height: document.documentElement.scrollHeight,
			};
		},

		scrollTo(ref) {
			get(ref).scrollIntoView({
				block: "center",
				inline: "center",
				behavior: "instant",
			});
			return true;
		},

		rect(ref) {
			const el = get(ref);
			el.scrollIntoView({
				block: "center",
				inline: "center",
				behavior: "instant",
			});
			const r = el.getBoundingClientRect();
			return {
				x: r.x + scrollX,
				y: r.y + scrollY,
				w: r.width,
				h: r.height,
			};
		},

		text(ref) {
			return nameOf(get(ref));
		},

		attr(ref, name) {
			return get(ref).getAttribute(name);
		},

		value(ref) {
			const el = get(ref);
			return "value" in el ? el.value : el.textContent;
		},

		read(ref, max, around) {
			const root = ref ? get(ref) : document.body;
			const text = (root.innerText ?? root.textContent ?? "")
				.replace(/\n{3,}/g, "\n\n")
				.trim();
			if (around != null) {
				// Every occurrence of `around`, with max/2 characters of context on each side.
				const re =
					typeof around === "object"
						? new RegExp(
								around.re,
								around.flags.includes("g")
									? around.flags
									: `${around.flags}g`,
							)
						: new RegExp(
								String(around).replace(
									/[.*+?^${}()|[\]\\]/g,
									"\\$&",
								),
								"gi",
							);
				const half = Math.floor(max / 2);
				const hits = [...text.matchAll(re)]
					.slice(0, 10)
					.map(
						(m) =>
							`…${text.slice(Math.max(0, m.index - half), m.index + m[0].length + half)}…`,
					);
				return hits.length
					? hits.join("\n---\n")
					: `(no match for ${around.re ?? around})`;
			}
			return text.length > max
				? `${text.slice(0, max)}\n… ${text.length - max} more chars`
				: text;
		},

		info() {
			return {
				url: location.href,
				title: document.title,
				readyState: document.readyState,
				viewport: {
					w: innerWidth,
					h: innerHeight,
					dpr: devicePixelRatio,
				},
				scroll: {
					x: Math.round(scrollX),
					y: Math.round(scrollY),
					height: document.documentElement.scrollHeight,
				},
			};
		},

		snapshot({ all = false, limit = 150, within = null } = {}) {
			const root = within ? get(within) : document.body;
			const found = new Set(
				[...root.querySelectorAll(`${INTERACTIVE},h1,h2,h3`)].filter(
					(el) => all || inViewport(el),
				),
			);
			for (const el of pointerRoots(root, !all)) found.add(el);
			const els = [...found].filter(isVisible).sort(byDocumentOrder);
			const lines = els.slice(0, limit).map(controlLine);
			const header = `${document.title} — ${location.href}\nviewport ${innerWidth}x${innerHeight}, scrolled ${Math.round(scrollY)}/${document.documentElement.scrollHeight}${all ? "" : " (in-view elements only)"}`;
			const more =
				els.length > limit
					? `\n… ${els.length - limit} more; pass {limit} or scroll`
					: "";
			return `${header}\n${lines.join("\n")}${more}`;
		},
	};
})();
