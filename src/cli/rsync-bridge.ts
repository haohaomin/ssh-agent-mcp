import net from 'node:net';
// Invoked by rsync as its remote-shell executable. No credentials are written to disk.
const [socketPath, _host, ...command]=process.argv.slice(2);
const socket=net.connect(socketPath);let buffer='',finished=false;
process.stdin.pause();
socket.on('connect',()=>socket.write(JSON.stringify({command})+'\n'));
socket.on('error',error=>{console.error(error.message);process.exitCode=1;});
socket.on('data',chunk=>{
  buffer+=chunk.toString();let at;
  while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);const packet=JSON.parse(line);
    if(packet.ready){process.stdin.on('data',b=>{if(!socket.write(JSON.stringify({stdin:b.toString('base64')})+'\n'))process.stdin.pause();});socket.on('drain',()=>process.stdin.resume());process.stdin.on('end',()=>socket.write('{"end":true}\n'));process.stdin.resume();}
    if(packet.stdout)process.stdout.write(Buffer.from(packet.stdout,'base64'));
    if(packet.stderr)process.stderr.write(Buffer.from(packet.stderr,'base64'));
    if(packet.error){console.error(packet.error);process.exitCode=1;}
    if(packet.exit!==undefined){finished=true;process.exitCode=packet.exit;socket.end();process.stdin.destroy();}
  }
});
socket.on('close',()=>{if(!finished)process.exitCode=1;process.stdin.destroy();});
