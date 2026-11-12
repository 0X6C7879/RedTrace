import { workerData } from 'node:worker_threads'
import { openIndex } from './knowledge.ts'
const [root, filename, sources, wordlists, nucleiRoot] = workerData
openIndex(root, filename, sources, wordlists, nucleiRoot).close()
