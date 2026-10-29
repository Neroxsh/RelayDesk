import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { sendClaudePrompt } from "../agent/claude-runner.mjs";
import { interactions } from "../agent/interactions.mjs";
import { configureClaudeHome } from "../agent/claude-sessions.mjs";

test("Claude duplex keeps stdin open for questions, permission changes and explicit rejection, including split UTF-8", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relaydesk-duplex-")), fake = path.join(root, "claude-fixture.mjs");
  const previous = process.env.RELAYDESK_CLAUDE_EXECUTABLE;
  process.env.RELAYDESK_CLAUDE_EXECUTABLE = fake; configureClaudeHome(root);
  t.after(async () => { configureClaudeHome(); if (previous === undefined) delete process.env.RELAYDESK_CLAUDE_EXECUTABLE; else process.env.RELAYDESK_CLAUDE_EXECUTABLE = previous; await rm(root, { recursive: true, force: true }); });
  await writeFile(fake, `
    if(process.argv.includes('--version')) { console.log('2.1.312 fixture');process.exit(0); }
    if(process.argv.includes('--help')) { console.log('--print --resume --session-id --output-format stream-json --input-format stream-json --permission-mode dontAsk plan --allowedTools --allow-dangerously-skip-permissions');process.exit(0); }
    if(!process.argv.includes('--permission-prompt-tool')||!process.argv.includes('--input-format')) process.exit(4);
    let buffer='';const send=row=>process.stdout.write(JSON.stringify(row)+'\\n');
    process.stdin.on('data',chunk=>{ buffer+=chunk;const lines=buffer.split('\\n');buffer=lines.pop();for(const line of lines){
      const row=JSON.parse(line);
      if(row.type==='user') { send({type:'system',subtype:'init',model:'fixture-model',permissionMode:'default'});send({type:'control_request',request_id:'q',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input:{questions:[{question:'选择',options:[{label:'你好'},{label:'取消'}]}]}}}); }
      if(row.type==='control_request') send({type:'control_response',response:{subtype:'success',request_id:row.request_id,response:{}}});
      if(row.type==='control_response'&&row.response.request_id==='q') {
        if(row.response.response.updatedInput.answers['选择']!=='你好') process.exit(5);
        send({type:'control_request',request_id:'command',request:{subtype:'can_use_tool',tool_name:'PowerShell',input:{command:'do-not-run'}}});
      }
      if(row.type==='control_response'&&row.response.request_id==='command') {
        if(row.response.response.behavior!=='deny') process.exit(6);
        const bytes=Buffer.from(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'手机确认成功'}]}})+'\\n');
        let offset=0;const next=()=>{if(offset<bytes.length){const part=bytes.subarray(offset,offset+2);offset+=2;process.stdout.write(part,next)}else{send({type:'result',is_error:false,permission_denials:[{tool_name:'PowerShell'}]});}};next();
      }
    }});
  `);
  const session = { id: randomUUID(), isNew: true, cwd: root }, seen = new Set(), events = [];
  let run, listenerError;
  const listener = async (id) => {
    if (id !== session.id) return;
    for (const request of interactions.list(id)) {
      if (seen.has(request.id)) continue; seen.add(request.id);
      try {
        if (request.kind === "question") { await run.setPermission("read-only"); interactions.respond(id, request.id, "answer", { "选择": ["你好"] }); }
        else interactions.respond(id, request.id, "deny");
      } catch (error) { listenerError = error; run?.stop(); }
    }
  };
  interactions.on("changed", listener); t.after(() => { interactions.off("changed", listener); run?.stop(); });
  run = await sendClaudePrompt(session, "测试", { permission: "ask" }, (event) => events.push(event));
  await run.completed;
  assert.equal(listenerError, undefined);
  assert.deepEqual([...seen], ["q", "command"]);
  assert.equal(run.settings.permission, "read-only");
  assert.equal(events.find((event) => event.type === "assistant")?.text, "手机确认成功");
  assert.deepEqual(interactions.list(session.id), []);
});
