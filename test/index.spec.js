import { env, createExecutionContext, waitOnExecutionContext, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

const SKILL_ID = env.SKILL_ID;

function aliceBody(utterance, { skillId = SKILL_ID, userId = "user-1" } = {}) {
	return {
		version: "1.0",
		session: { skill_id: skillId, user: { user_id: userId }, session_id: "s-1" },
		request: { original_utterance: utterance },
	};
}

// Вызов воркера напрямую с нужным окружением; ждём фоновые записи в KV.
async function call({ path = "/", method = "POST", body, extraEnv = {} } = {}) {
	const req = new Request(`http://example.com${path}`, {
		method,
		body: method === "POST" ? JSON.stringify(body ?? aliceBody("")) : undefined,
	});
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, { ...env, ...extraEnv }, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function say(utterance, opts) {
	const res = await call({ body: aliceBody(utterance, opts) });
	expect(res.status).toBe(200);
	return res.json();
}

describe("защита вебхука", () => {
	it("на GET отвечает 404", async () => {
		expect((await call({ method: "GET" })).status).toBe(404);
	});

	it("без WEBHOOK_SECRET принимает POST на любой путь", async () => {
		expect((await call({ path: "/anything" })).status).toBe(200);
	});

	it("с WEBHOOK_SECRET отвечает только на секретный путь", async () => {
		const extraEnv = { WEBHOOK_SECRET: "s3cret" };
		expect((await call({ path: "/", extraEnv })).status).toBe(404);
		expect((await call({ path: "/wrong", extraEnv })).status).toBe(404);
		expect((await call({ path: "/s3cret", extraEnv })).status).toBe(200);
	});

	it("отклоняет чужой skill_id", async () => {
		const res = await call({ body: aliceBody("привет", { skillId: "other" }) });
		expect(res.status).toBe(403);
	});

	it("на битый JSON отвечает 400", async () => {
		const res = await worker.fetch(new Request("http://example.com/", { method: "POST", body: "{" }), env, createExecutionContext());
		expect(res.status).toBe(400);
	});

	it("работает и через SELF (реальная привязка из wrangler.jsonc)", async () => {
		const res = await SELF.fetch("http://example.com/", { method: "POST", body: JSON.stringify(aliceBody("")) });
		expect(res.status).toBe(200);
	});
});

describe("команды", () => {
	it("приветствует на пустую реплику", async () => {
		const data = await say("");
		expect(data.response.text).toContain("Привет");
		expect(data.response.end_session).toBe(false);
	});

	it("возвращает version и session из запроса", async () => {
		const data = await say("помощь");
		expect(data.version).toBe("1.0");
		expect(data.session.session_id).toBe("s-1");
	});

	it("справка", async () => {
		const data = await say("Что ты умеешь?");
		expect(data.response.text).toContain("запомни");
		expect(data.response.end_session).toBe(false);
	});

	it("«пока» завершает сессию", async () => {
		const data = await say("Пока!");
		expect(data.response.end_session).toBe(true);
	});

	it("запоминает, перечисляет и забывает факты", async () => {
		expect((await say("Запомни, что я люблю чай")).response.text).toBe("Запомнил.");
		expect((await say("что ты обо мне знаешь")).response.text).toContain("я люблю чай");
		expect((await say("забудь всё обо мне")).response.text).toContain("забыл");
		expect((await say("что ты обо мне знаешь")).response.text).toContain("Пока ничего");
	});

	it("факты разных пользователей не смешиваются", async () => {
		await say("запомни, что я люблю чай", { userId: "alice" });
		const data = await say("что ты обо мне знаешь", { userId: "bob" });
		expect(data.response.text).toContain("Пока ничего");
	});

	it("просит уточнить, если нечего запомнить", async () => {
		expect((await say("запомни")).response.text).toBe("Что именно запомнить?");
	});

	it("отклоняет слишком длинный факт", async () => {
		const data = await say("запомни, что " + "а".repeat(300));
		expect(data.response.text).toContain("Слишком длинно");
		expect((await say("что ты обо мне знаешь")).response.text).toContain("Пока ничего");
	});

	it("хранит не больше 30 фактов", async () => {
		for (let i = 1; i <= 32; i++) await say(`запомни, что факт номер ${i}`);
		const text = (await say("что ты обо мне знаешь")).response.text;
		expect(text).not.toContain("факт номер 1.");
		expect(text).not.toContain("факт номер 2.");
		expect(text).toContain("факт номер 32");
	});

	it("сообщает, если KV не смог сохранить факт", async () => {
		const brokenKv = {
			get: async () => null,
			put: async () => {
				throw new Error("KV put() limit exceeded");
			},
			delete: async () => {},
		};
		const res = await call({ body: aliceBody("запомни, что я люблю чай"), extraEnv: { ANSWERS: brokenKv } });
		expect((await res.json()).response.text).toContain("Не получилось сохранить");
	});
});

describe("лимит вопросов", () => {
	const today = () => new Date().toISOString().slice(0, 10);

	it("не пускает к LLM после исчерпания лимита", async () => {
		await env.ANSWERS.put(`r:user-1:${today()}`, "5");
		const res = await call({ body: aliceBody("сколько будет два плюс два"), extraEnv: { DAILY_LIMIT: "5" } });
		expect((await res.json()).response.text).toContain("лимит");
	});

	it("команды не тратят лимит и работают при исчерпанном лимите", async () => {
		await env.ANSWERS.put(`r:user-1:${today()}`, "5");
		const res = await call({ body: aliceBody("запомни, что я люблю чай"), extraEnv: { DAILY_LIMIT: "5" } });
		expect((await res.json()).response.text).toBe("Запомнил.");
	});
});
