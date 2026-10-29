import net from 'node:net';

// Checks the permission needed by Hardhat and both local HTTP services.
const server = net.createServer();
server.on('error', error => {
  console.error(`Loopback unavailable: ${error.code}: ${error.message}`);
  process.exitCode = 1;
});
server.listen(0, '127.0.0.1', () => {
  console.log('Loopback binding permitted');
  server.close();
});
