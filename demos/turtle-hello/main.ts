/**
 * turtle-hello demo: load demo.py as text and hand it to the shared
 * worker-spawning harness.
 */

import { runDemo } from '../../src/demo-harness.js';
import pythonCode from './demo.py?raw';

runDemo({ pythonCode });
