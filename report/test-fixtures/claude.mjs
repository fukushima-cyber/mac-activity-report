#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const dir = prompt.match(/ログ格納フォルダ: (.+)/)[1];
const [name] = (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
const source = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
console.log(JSON.stringify([{
  employee_slug: source.employee, employee_name: "Fixture", active_hours: 1,
  window_count: source.window_count, summary: "Fixture summary", waste_notes: "None",
  automation_notes: "None", timeline: [],
}]));
