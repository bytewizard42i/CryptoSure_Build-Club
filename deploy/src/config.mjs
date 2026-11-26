// ============================================================================
// config.mjs — which network, which addresses, which folders
// ============================================================================
// WHAT THIS IS
//   The one place that knows the web addresses of each Midnight network and
//   where things live on this computer. Every other script asks this file
//   instead of typing a URL itself, so changing network is a one-line change.
//
// WHERE THE FACTS CAME FROM (checked 2026-11-25/26)
//   - Preview endpoints and network id: Midnight's official docs repository
//     (github.com/midnightntwrk/midnight-docs) and the task brief.
//   - Versions: the official compatibility matrix,
//     docs/relnotes/support-matrix.json in that same repository.
//   - In Midnight.js 5 there is NO global setNetworkId(). The network id is
//     handed to each provider/wallet as configuration instead
//     (@midnight-ntwrk/midnight-js-types, interface MidnightConfig).
//
// NOTHING SECRET LIVES HERE
//   The Blockfrost project id (needed only for preprod) is read from an
//   environment variable at run time and is never written to disk by us.
//
// IDEAS, NOT BUILT
//   IDEA: a 'mainnet' entry, once the program has been audited.
//   IDEA: an 'undeployed' entry for a local docker node + indexer.
// ============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---- Folders ---------------------------------------------------------------
// deploy/src/config.mjs -> deploy/ -> the repository root.
export const DEPLOY_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPOSITORY_ROOT = path.resolve(DEPLOY_FOLDER, '..');
// The Compact compiler's output: build/<ContractName>/{contract,keys,zkir,compiler}
export const BUILD_FOLDER = path.join(REPOSITORY_ROOT, 'build');
// One JSON file per network, recording what we deployed there. Safe to commit:
// it holds only public addresses and transaction ids.
export const DEPLOYMENTS_FOLDER = path.join(DEPLOY_FOLDER, 'deployments');
// Machine-local data that must NOT be committed (see deploy/.gitignore):
// the encrypted private-state database and copies of the compiled contracts.
export const LOCAL_STATE_FOLDER = path.join(DEPLOY_FOLDER, '.local-state');
export const COMPILED_CONTRACT_COPIES_FOLDER = path.join(DEPLOY_FOLDER, '.compiled-contracts');

// ---- Where the deployer's seed is read from ---------------------------------
// Only the PATH is here. The seed itself is read at run time by seed-file.mjs
// and is never printed or written anywhere.
const DEFAULT_DEPLOYER_SEED_FILE = '/home/js/utils_Midnight/preProd-Wallets/tdust-secrets/sarah.seed';
export function deployerSeedFilePath() {
  return process.env.CRYPTOSURE_DEPLOYER_SEED_FILE || DEFAULT_DEPLOYER_SEED_FILE;
}
/** True when the person running the script named a seed file themselves. */
export function deployerSeedFileWasChosenExplicitly() {
  return Boolean(process.env.CRYPTOSURE_DEPLOYER_SEED_FILE);
}

// ---- The proof server --------------------------------------------------------
// A program running on THIS computer (docker image midnightntwrk/proof-server)
// that turns private inputs into zero-knowledge proofs. Private inputs are sent
// to it, so it should only ever be a local address.
export function proofServerUrl() {
  return process.env.CRYPTOSURE_PROOF_SERVER_URL || 'http://127.0.0.1:6300';
}

// How long a transaction we build stays valid, in seconds. Proving eight
// circuits on a laptop can take a while, so this is generous.
export const TRANSACTION_TIME_TO_LIVE_SECONDS = 30 * 60;

// ---- The network table --------------------------------------------------------
// Each entry is a FUNCTION so that an entry needing an environment variable
// (preprod) only complains when someone actually asks for that network.
const NETWORK_BUILDERS = {
  // Preview: Midnight's public test network that needs no account.
  // TESTED: yes (see deploy/README.md for exactly what was run).
  preview: () => ({
    name: 'preview',
    networkId: 'preview',
    tested: true,
    nodeRpcHttpUrl: 'https://rpc.preview.midnight.network',
    nodeRpcWebSocketUrl: 'wss://rpc.preview.midnight.network',
    indexerHttpUrl: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWebSocketUrl: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    faucetWebPage: 'https://midnight-tmnight-preview.nethermind.dev/'
  }),

  // Local: a private one-node chain in Docker on this computer, for
  // REHEARSALS (see deploy/local-network/compose.yml). Its network id is
  // 'undeployed', the id Midnight uses for chains that are not public. A
  // wallet funded at genesis exists there, so no faucet is needed.
  // TESTED: yes, this is where the scripts were exercised end to end.
  local: () => ({
    name: 'local',
    networkId: 'undeployed',
    tested: true,
    nodeRpcHttpUrl: 'http://127.0.0.1:9944',
    nodeRpcWebSocketUrl: 'ws://127.0.0.1:9944',
    indexerHttpUrl: 'http://127.0.0.1:8088/api/v4/graphql',
    indexerWebSocketUrl: 'ws://127.0.0.1:8088/api/v4/graphql/ws',
    faucetWebPage: null,
    // NOT A SECRET: the publicly documented seed of the wallet that every
    // Midnight "dev" chain funds at genesis (it appears in Midnight's own
    // example code). It controls nothing on any public network. Used only
    // when the network is 'local' and no seed file was named explicitly.
    wellKnownGenesisSeedHex: '0000000000000000000000000000000000000000000000000000000000000001'
  }),

  // Preprod: served by Blockfrost, which needs a (free) project id.
  // UNTESTED: nothing in deploy/ has ever been run against preprod. The URL
  // shapes are from the task brief; the WebSocket URLs in particular are an
  // assumption (same host, ws scheme, "/ws" for the indexer) and must be
  // checked against Blockfrost's documentation before first use.
  preprod: () => {
    const projectId = process.env.BLOCKFROST_MIDNIGHT_PREPROD_PROJECT_ID;
    if (!projectId) {
      throw new Error(
        'The preprod network is served by Blockfrost and needs a project id.\n' +
        'Next step: create a Midnight preprod project at blockfrost.io, then run with\n' +
        '  BLOCKFROST_MIDNIGHT_PREPROD_PROJECT_ID=<your id> npm run <script> -- --network preprod\n' +
        '(Put it in your shell or a git-ignored .env file, never in code.)'
      );
    }
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
      throw new Error('BLOCKFROST_MIDNIGHT_PREPROD_PROJECT_ID contains unexpected characters; expected letters, digits, "-" or "_".');
    }
    const query = `?project_id=${projectId}`;
    return {
      name: 'preprod',
      networkId: 'preprod',
      tested: false,
      nodeRpcHttpUrl: `https://rpc.midnight-preprod.blockfrost.io${query}`,
      nodeRpcWebSocketUrl: `wss://rpc.midnight-preprod.blockfrost.io${query}`,
      indexerHttpUrl: `https://midnight-preprod.blockfrost.io/api/v0${query}`,
      indexerWebSocketUrl: `wss://midnight-preprod.blockfrost.io/api/v0/ws${query}`,
      faucetWebPage: 'https://midnight-tmnight-preprod.nethermind.dev/'
    };
  }
};

export const KNOWN_NETWORK_NAMES = Object.keys(NETWORK_BUILDERS);

/**
 * The settings for one network.
 * @param {string} networkName  'preview', 'local' or 'preprod'
 */
export function getNetworkConfig(networkName) {
  const build = NETWORK_BUILDERS[networkName];
  if (build === undefined) {
    throw new Error(`Unknown network "${networkName}". Known networks: ${KNOWN_NETWORK_NAMES.join(', ')}.`);
  }
  const network = build();
  if (!network.tested) {
    console.warn(`WARNING: the "${networkName}" network configuration is UNTESTED. Expect to fix URLs before it works.`);
  }
  return network;
}

/**
 * Which network a script should use: `--network <name>` on the command line,
 * else the CRYPTOSURE_NETWORK environment variable, else preview.
 */
export function networkNameFromCommandLine(commandLineArguments = process.argv.slice(2)) {
  const flagPosition = commandLineArguments.indexOf('--network');
  if (flagPosition !== -1) {
    const value = commandLineArguments[flagPosition + 1];
    if (value === undefined) throw new Error('--network needs a value, for example: --network preview');
    return value;
  }
  return process.env.CRYPTOSURE_NETWORK || 'preview';
}

/**
 * The exact SDK versions installed, read from deploy/package.json so the
 * deployment record can say what it was made with. (They are pinned exactly;
 * see README "Versions".)
 */
export function installedSdkVersions() {
  const packageJson = JSON.parse(readFileSync(path.join(DEPLOY_FOLDER, 'package.json'), 'utf8'));
  return { ...packageJson.dependencies };
}

/**
 * The compiler that produced build/, as the compiler itself recorded it in
 * build/<Contract>/compiler/contract-info.json.
 */
export function compilerVersionsOfBuild(contractName = 'ClearanceRegistry') {
  const info = JSON.parse(readFileSync(path.join(BUILD_FOLDER, contractName, 'compiler', 'contract-info.json'), 'utf8'));
  return {
    compactCompiler: info['compiler-version'],
    compactLanguage: info['language-version'],
    compactRuntime: info['runtime-version']
  };
}
