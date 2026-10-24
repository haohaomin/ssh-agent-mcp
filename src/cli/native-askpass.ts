// Invoked exclusively by native SSH; the secret is inherited in the child environment, never stored in a script.
const prompt=process.argv.slice(2).join(' ');
const value=/passphrase/i.test(prompt)?process.env.SSH_AGENT_NATIVE_PASSPHRASE:process.env.SSH_AGENT_NATIVE_PASSWORD;
if(value===undefined)process.exitCode=1;else process.stdout.write(value+'\n');
