// Навык Алисы → LLM через ai.starimg.ru (Cloudflare Worker).
// Гибридная схема + память диалога + долгосрочные факты.
//
// Быстрый ответ (до INLINE_WAIT_MS) — сразу. Медленный — «Секунду, думаю»,
// ответ досчитывается в фоне и отдаётся на реплику-подтверждение («ну», «ага»..., см. FOLLOW_UP).
//
// Память:
//   • диалог — последние HISTORY_MESSAGES сообщений, живёт HISTORY_TTL (переживает перезапуск навыка);
//   • факты — «Запомни, что …», хранятся бессрочно, до MAX_FACTS штук по MAX_FACT_LENGTH символов.
// Команды:
//   «запомни, что …»            — добавить факт
//   «что ты обо мне знаешь»      — перечислить факты
//   «забудь всё обо мне»         — удалить факты
//   «забудь» / «новая тема»      — очистить только диалог
//   «помощь» / «что ты умеешь»   — справка
//   «пока» / «хватит»            — завершить сессию
//
// Нужно:
//   секрет ANTHROPIC_API_KEY — ключ ai.starimg.ru
//   KV-хранилище с привязкой ANSWERS (kv_namespaces в wrangler.jsonc)
// Необязательно (защита включается, только если заданы):
//   секрет WEBHOOK_SECRET — секретный путь: Webhook URL навыка = https://<воркер>/<WEBHOOK_SECRET>
//   переменная SKILL_ID — id навыка в Яндекс Диалогах (wrangler.jsonc, vars)
//   переменная DAILY_LIMIT — вопросов к LLM в сутки на пользователя (по умолчанию 100, 0 — без лимита)

// Значения по умолчанию; переопределяются переменными API_URL и MODEL в wrangler.jsonc (vars).
const API_URL = "https://ai.starimg.ru/v1/messages";
const MODEL = "deepseek-v4.1-flash";
const INLINE_WAIT_MS = 2500;     // Алиса ждёт ответ вебхука ~3 с; KV читается параллельно, запаса хватает
const API_TIMEOUT_MS = 25000;    // на все попытки вместе
const API_ATTEMPTS = 2;
const MAX_TOKENS = 200;
const PENDING_STALE_MS = 35000;  // «думаю» дольше этого — задание умерло, не ждём его
const HISTORY_MESSAGES = 10;
const HISTORY_TTL = 24 * 3600;   // диалог помним сутки
const ANSWER_TTL = 3600;
const RATE_TTL = 2 * 24 * 3600;  // счётчик вопросов живёт дольше суток, чтобы не терять его на границе дней
const DAILY_LIMIT = 100;
const MAX_FACTS = 30;
const MAX_FACT_LENGTH = 200;

const RESET_DIALOG = ["забудь", "новая тема", "сначала", "начнём сначала", "начнем сначала"];
const RESET_FACTS = ["забудь всё обо мне", "забудь все обо мне", "забудь всё что знаешь", "забудь все что знаешь"];
const LIST_FACTS = ["что ты обо мне знаешь", "что ты помнишь", "что ты про меня знаешь", "что ты запомнил"];
const BYE = ["пока", "хватит", "стоп", "выход", "выйти", "до свидания", "закрой навык"];
const HELP = ["помощь", "что ты умеешь", "что ты можешь", "справка"];
// Реплики, которыми забирают отложенный ответ. Остальные — новый вопрос, даже короткий.
const FOLLOW_UP = [
	"ну", "ну и", "ну что", "ну как", "ну и что", "ну давай", "и", "и что", "и как", "ага", "угу", "да",
	"так", "давай", "дальше", "готово", "что там", "продолжай", "слушаю", "жду", "ответ",
];

const BASE_SYSTEM =
	"Ты голосовой ассистент в колонке. Отвечай по-русски, коротко (1–3 предложения), " +
	"без markdown, списков и эмодзи. Учитывай предыдущие реплики диалога.";

export default {
	async fetch(req, env, ctx) {
		// Если задан WEBHOOK_SECRET — отвечаем только на POST /<секрет>, иначе любой мог бы тратить наш баланс LLM.
		// Не задан — защита выключена, принимаем любой POST.
		const path = new URL(req.url).pathname;
		if (req.method !== "POST" || (env.WEBHOOK_SECRET && !safeEqual(path, `/${env.WEBHOOK_SECRET}`))) {
			return new Response("not found", { status: 404 });
		}

		let alice;
		try {
			alice = await req.json();
		} catch {
			return new Response("bad json", { status: 400 });
		}

		if (env.SKILL_ID && alice.session?.skill_id !== env.SKILL_ID) {
			return new Response("forbidden", { status: 403 });
		}

		const utterance = (alice.request?.original_utterance || "").trim();
		const norm = normalize(utterance);

		// user_id есть, если пользователь авторизован в Яндексе; иначе — id устройства/приложения
		const uid =
			alice.session?.user?.user_id ||
			alice.session?.application?.application_id ||
			alice.session?.session_id ||
			"anon";
		const answerKey = `a:${uid}`;
		const historyKey = `h:${uid}`;
		const factsKey = `f:${uid}`;

		let text;
		let endSession = false;

		if (norm === "ping") {
			// Проверка доступности от платформы Диалогов — без LLM и без лимита.
			text = "pong";
		} else if (!utterance) {
			text = "Привет! Задавайте вопрос.";
		} else if (BYE.includes(norm)) {
			text = "До свидания!";
			endSession = true;
		} else if (HELP.includes(norm)) {
			text =
				"Задайте любой вопрос, отвечу коротко. Скажите «запомни, что…», чтобы я запомнил факт о вас, " +
				"«что ты обо мне знаешь» — перечислю, «забудь» — начнём тему заново, «пока» — выйду.";
		} else if (RESET_FACTS.includes(norm)) {
			ctx.waitUntil(kvDelete(env, factsKey));
			text = "Хорошо, я забыл всё, что вы просили запомнить.";
		} else if (RESET_DIALOG.includes(norm)) {
			ctx.waitUntil(Promise.all([kvDelete(env, historyKey), kvDelete(env, answerKey)]));
			text = "Хорошо, начнём с чистого листа.";
		} else if (LIST_FACTS.includes(norm)) {
			const facts = (await kvGet(env, factsKey)) || [];
			text = facts.length
				? "Я помню вот что: " + facts.join(". ") + "."
				: "Пока ничего. Скажите «запомни, что…», и я запомню.";
		} else if (/^запомни(\s|$)/.test(norm)) {
			const fact = utterance.replace(/^запомни[\s,:-]*(что\s+)?/i, "").trim();
			if (!fact) {
				text = "Что именно запомнить?";
			} else if (fact.length > MAX_FACT_LENGTH) {
				text = `Слишком длинно. Сократите до ${MAX_FACT_LENGTH} символов.`;
			} else {
				const facts = (await kvGet(env, factsKey)) || [];
				facts.push(fact);
				text = (await kvPut(env, factsKey, JSON.stringify(facts.slice(-MAX_FACTS))))
					? "Запомнил."
					: "Не получилось сохранить. Попробуйте позже.";
			}
		} else {
			// Всё нужное читаем разом: у Алисы жёсткий таймаут на ответ.
			const rateKey = `r:${uid}:${new Date().toISOString().slice(0, 10)}`;
			const [saved, history, facts, used] = await Promise.all([
				kvGet(env, answerKey),
				kvGet(env, historyKey),
				kvGet(env, factsKey),
				kvGet(env, rateKey),
			]);
			const limit = dailyLimit(env);

			if (saved && FOLLOW_UP.includes(norm)) {
				if (saved.status === "done") {
					text = saved.text;
				} else if (isStale(saved)) {
					text = "Ответ так и не пришёл. Спросите ещё раз.";
				} else {
					text = "Ещё думаю, секунду.";
				}
				if (text !== "Ещё думаю, секунду.") ctx.waitUntil(kvDelete(env, answerKey));
			} else if (limit > 0 && (Number(used) || 0) >= limit) {
				text = "На сегодня лимит вопросов исчерпан. Попробуйте завтра.";
			} else {
				ctx.waitUntil(kvPut(env, rateKey, String((Number(used) || 0) + 1), { expirationTtl: RATE_TTL }));

				const messages = [...(history || []), { role: "user", content: utterance }];
				const system = buildSystem(facts || []);
				// id задания: отложенный ответ пишется, только если в очереди всё ещё это задание,
				// иначе медленный старый вопрос перезапишет ответ на более новый.
				const jobId = crypto.randomUUID();

				const job = ask(system, messages, env);

				const quick = await Promise.race([
					job,
					new Promise((resolve) => setTimeout(() => resolve(null), INLINE_WAIT_MS)),
				]);

				// В историю попадают только ответы, которые пользователь услышит (или сможет забрать через «ну»).
				if (quick !== null) {
					text = quick.text;
					if (quick.ok) ctx.waitUntil(appendHistory(env, historyKey, utterance, quick.text));
					if (saved) ctx.waitUntil(kvDelete(env, answerKey));
				} else {
					const pending = { status: "pending", id: jobId, started: Date.now() };
					await kvPut(env, answerKey, JSON.stringify(pending), { expirationTtl: ANSWER_TTL });
					ctx.waitUntil(job.then((res) => finishJob(env, answerKey, jobId, res, historyKey, utterance)));
					text = "Секунду, думаю.";
				}
			}
		}

		return new Response(
			JSON.stringify({
				version: alice.version,
				session: alice.session,
				response: { text: text.length > 1024 ? cutToSentence(text, 1024) : text, end_session: endSession },
			}),
			{ headers: { "Content-Type": "application/json; charset=utf-8" } }
		);
	},
};

// KV на бесплатном плане ограничен (1000 записей в сутки): при сбое отвечаем пользователю всё равно.
async function kvGet(env, key) {
	try {
		return await env.ANSWERS.get(key, "json");
	} catch (e) {
		console.log("KV get failed", key, String(e));
		return null;
	}
}

async function kvPut(env, key, value, options) {
	try {
		await env.ANSWERS.put(key, value, options);
		return true;
	} catch (e) {
		console.log("KV put failed", key, String(e));
		return false;
	}
}

async function kvDelete(env, key) {
	try {
		await env.ANSWERS.delete(key);
	} catch (e) {
		console.log("KV delete failed", key, String(e));
	}
}

// Лимит вопросов к LLM на пользователя в сутки (UTC); 0 — без лимита.
function dailyLimit(env) {
	const raw = env.DAILY_LIMIT;
	return raw === undefined || raw === "" || Number.isNaN(Number(raw)) ? DAILY_LIMIT : Number(raw);
}

// Записи без started — от старой версии кода, их тоже считаем протухшими.
function isStale(saved) {
	return saved.status === "pending" && !(Date.now() - saved.started < PENDING_STALE_MS);
}

async function finishJob(env, key, jobId, res, historyKey, utterance) {
	const current = await kvGet(env, key);
	if (current?.id !== jobId) return; // пока думали, задали новый вопрос — этот ответ никто не услышит
	await kvPut(env, key, JSON.stringify({ status: "done", id: jobId, text: res.text }), { expirationTtl: ANSWER_TTL });
	if (res.ok) await appendHistory(env, historyKey, utterance, res.text);
}

// Дописываем к актуальной истории, а не к снимку на момент вопроса: иначе параллельный вопрос затрёт соседний.
async function appendHistory(env, historyKey, question, answer) {
	const history = (await kvGet(env, historyKey)) || [];
	const updated = [...history, { role: "user", content: question }, { role: "assistant", content: answer }];
	await kvPut(env, historyKey, JSON.stringify(updated.slice(-HISTORY_MESSAGES)), { expirationTtl: HISTORY_TTL });
}

// Голосом разметку не прочитать: убираем markdown, списки и эмодзи.
function toSpeech(text) {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/\p{Extended_Pictographic}️?/gu, "")
		.replace(/[*_`#>]+/g, "")
		.split("\n")
		.map((line) => line.replace(/^\s*(?:[-•–]|\d+[.)])\s+/, "").trim())
		.filter(Boolean)
		.map((line, i, lines) => (i < lines.length - 1 && !/[.!?…:;,]$/.test(line) ? line + "." : line))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

// Обрезка по концу предложения, чтобы Алиса не обрывала фразу на полуслове.
function cutToSentence(text, max = Infinity) {
	const cut = text.slice(0, max);
	const ends = [...cut.matchAll(/[.!?…](?=\s|$)/g)];
	const last = ends.at(-1);
	if (last && last.index > cut.length * 0.3) return cut.slice(0, last.index + 1);
	return cut.length < text.length ? cut.slice(0, max - 1).trimEnd() + "…" : cut + "…";
}

// Сравнение за постоянное время, чтобы секретный путь нельзя было подобрать по времени ответа.
function safeEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function buildSystem(facts) {
	if (!facts.length) return BASE_SYSTEM;
	return (
		BASE_SYSTEM +
		"\n\nЧто пользователь просил запомнить о себе (используй, когда это к месту, но не перечисляй без повода):\n- " +
		facts.join("\n- ")
	);
}

function normalize(s) {
	return s.toLowerCase().replace(/ё/g, "е").replace(/[?!.,]/g, " ").replace(/\s+/g, " ").trim();
}

// Один повтор при 5xx или сетевой ошибке; общий бюджет времени — API_TIMEOUT_MS на обе попытки.
async function ask(system, messages, env) {
	const apiKey = env.ANTHROPIC_API_KEY;
	const apiUrl = env.API_URL || API_URL;
	const model = env.MODEL || MODEL;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
	const started = Date.now();
	try {
		for (let attempt = 1; ; attempt++) {
			const retry = attempt < API_ATTEMPTS;
			let r;
			try {
				r = await fetch(apiUrl, {
					method: "POST",
					signal: ctrl.signal,
					headers: {
						"x-api-key": apiKey,
						"Authorization": `Bearer ${apiKey}`,
						"anthropic-version": "2023-06-01",
						"content-type": "application/json",
					},
					body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system, messages }),
				});
			} catch (e) {
				console.log("API exception after", Date.now() - started, "ms, attempt", attempt, ":", String(e));
				if (retry && !ctrl.signal.aborted) continue;
				return { ok: false, text: "Ответ так и не пришёл. Спросите ещё раз." };
			}

			if (!r.ok) {
				console.log("API error", r.status, "attempt", attempt, await r.text());
				if (retry && r.status >= 500) continue;
				return { ok: false, text: "Не получилось получить ответ. Попробуйте ещё раз." };
			}

			const data = await r.json();
			console.log("Answered in", Date.now() - started, "ms, model", model, ", attempt", attempt, ", history:", messages.length - 1);
			let text = toSpeech(data.content?.map((b) => b.text || "").join("") || "");
			if (text && data.stop_reason === "max_tokens") text = cutToSentence(text);
			return text ? { ok: true, text } : { ok: false, text: "Пустой ответ." };
		}
	} catch (e) {
		console.log("API exception after", Date.now() - started, "ms:", String(e));
		return { ok: false, text: "Ответ так и не пришёл. Спросите ещё раз." };
	} finally {
		clearTimeout(timer);
	}
}
