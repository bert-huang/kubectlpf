#! /usr/bin/env node

'use strict';

const exec = require('child_process').exec;
const fs = require('fs');
const chalk = require('chalk');
const timestamp = require('time-stamp');
const _ = require('lodash');

let systemDefinedPods;
let localDefinedPods;
let namespace;
let kubeConfig;

const runningPods = [];

const path = require('path');

function resolveHome(filepath) {
	if (filepath[0] === '~') {
		return path.join(process.env.HOME, filepath.slice(1));
	}
	return path;
}

try {
	systemDefinedPods = JSON.parse(fs.readFileSync(resolveHome('~/.kube/pods.json'), 'utf-8'));
}
catch (e) {
	systemDefinedPods = {};
}

try {
	localDefinedPods = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'pods.json'), 'utf-8'));
}
catch (e) {
	localDefinedPods = {}
}

_.merge(systemDefinedPods, localDefinedPods);

// turn all formats into this format
function standardiseConfig(pods) {
	const toDelete = [];

	for (svc of pods) {
		if (!_.isObject(pods[svc])) {
			const port = pods[svc];
			pods[svc] = {
				from: port,
				to: port,
				namespace: namespace
			}
		} else if (pods[svc].to) {
			pods[svc].from = pods[svc].from || pods[svc].to;
			pods[svc].namespace = pods[svc].namespace || namespace;
		} else {
			toDelete.push(svc);
		}
	}

	if (toDelete.length > 0) {
		console.log('Ignoring pods ', toDelete, 'they are incorrectly configured.');
		_(toDelete).each((svc) => {
			delete pods[svc];
		})
	}
}


function timeLog(line) {
	console.log(`[${chalk.grey(timestamp('HH:mm:ss'))}] ${line}`);
}

let restartAttempt = 0;

function getPods(callback) {
	exec(`kubectl get pods${ kubeConfig ? ' --kubeconfig ' + kubeConfig : ''}${ namespace ? ' --namespace ' + namespace : ''}`, function (error, stdout, stderr) {
		if (error) {
			if (stderr.match(/network is unreachable/) || stderr.match(/handshake timeout/) || stderr.match(/network is down/) || stderr.match(/i\/o timeout/)) {
				timeLog(`Network error, restarting (${restartAttempt})...`);
				restartAttempt++;
				runningPods.forEach(pod => {
					if (pod.initialized) {
						pod.initialized = false;
						pod.childProcess.kill();
					}
				});
				callback(true);
			} else {
				throw stderr;
			}
		} else {
			if (restartAttempt > 0) {
				restartAttempt = 0;
				timeLog(`Connection established, restarting port forwarding for every pod...`);
			}
			callback(false, stdout, true);
		}
	});
}

function getPodId(rawPods, podName, silent) {
	const lines = rawPods.split('\n');

	const filterPods = [];
	for (let count = 0; count < lines.length; count++) {
		if (lines[count].startsWith(podName)) {
			filterPods.push(lines[count]);
		}
	}
	const joined = filterPods.join('\n');
	const match = (new RegExp('(' + podName + '[-\\da-z]*).*(Running)', 'g')).exec(joined);
	if (match) {
		return match[1];
	} else {
		const errorMatch = (new RegExp('(' + podName + '[-\\da-z]*)[\\s]*[\\d]\\/[\\d][\\s]*([a-zA-Z]*)[\\s]', 'g')).exec(joined);
		if (errorMatch) {
			if (silent) {
				return false;
			} else {
				throw `Pod ${chalk.cyan(podName)} is in ${chalk.cyan(errorMatch[2])} state, needs to be ${chalk.cyan('Running')}`;
			}
		} else {
			if (silent) {
				return false;
			} else {
				throw `Could not find pod ${chalk.cyan(podName)}, available pods${ namespace ? ' (namespace: ' + namespace + ')' : ''}: \n${joined}`;
			}
		}
	}
}

function portForwardPod(pod) {
	const child = exec(`kubectl port-forward ${pod.id} ${pod.from}${pod.to ? ':' + pod.to}${ kubeConfig ? ' --kubeconfig=' + kubeConfig : ''}${ pod.namespace ? ' --namespace=' + pod.namespace : ''}`);

	child.stdout.on('data', function (data) {
		processKubectlLog(data, pod, child);
	});
	child.stderr.on('data', function (data) {
		processKubectlLog(data, pod, child);
	});
	child.on('close', function (code) {
		//nothing for now
	});

	pod.childProcess = child;
}

function healthCheck() {
	getPods((error, rawPods, silent) => {
		if (error) return;
		runningPods.forEach(pod => {
			if (!pod.restartingState) {
				const match = (new RegExp('(' + pod.id + ').*(Running)', 'g')).exec(rawPods);
				if (!match || !pod.initialized) {
					pod.restartingState = true;
					pod.childProcess.kill();
					pod.initialized = false;
					if (!silent) {
						timeLog(`Detected death of ${chalk.cyan(pod.name)}. Trying to restart port forwarding...`);
					}
					let attempt = 0;
					const maxAttempt = 20;
					const attemptDuration = 5000;
					const tryReinitPod = () => {
						getPods((error, rawPods) => {
							if (error) return;
							const podId = getPodId(rawPods, pod.name, true);
							if (podId) {
								pod.id = podId;
								portForwardPod(pod);
								pod.restartingState = false;
							} else {
								if (attempt >= maxAttempt) {
									timeLog(chalk.red(`Failed to resume forwarding for ${chalk.cyan(pod.name)}`));
									process.exit();
								} else {
									timeLog(`Waiting for ${chalk.cyan(pod.name)} to come up (${attempt})...`);
									attempt++;
									pod.initInterval = setTimeout(tryReinitPod, attemptDuration)
								}
							}
						});
					};
					if (pod.initInterval) {
						clearTimeout(pod.initInterval);
					}
					tryReinitPod();
				}
			}
		});
	});
}

function processKubectlLog(logLine, pod, child) {
	if (logLine.match(/Forwarding from/)) {
		if (!pod.initialized) {
			pod.initialized = true;
			timeLog(`Started port forwarding for ${chalk.cyan(pod.name)} on port ${chalk.magenta(pod.port)}`);
		}
	} else if (logLine.match(/Handling connection/)) {
		timeLog(`Processing request for ${chalk.cyan(pod.name)}`);
	} else if (logLine.match(/an error occurred forwarding/)) {
		timeLog(`Unable to process request for ${chalk.cyan(pod.name)}`);
		healthCheck();
	} else if (logLine.match(/address already in use/) || logLine.match(/Unable to listen on any of the requested ports/)) {
		if (!pod.excluded) {
			pod.excluded = true;
			pod.childProcess.kill();
			timeLog(`Pod ${chalk.cyan(pod.name)} seems to be already forwarded, excluding...`);
			_.pull(runningPods, pod);
			if (!runningPods.length) {
				timeLog(chalk.red(`No pods left to port forward, exiting`));
				process.exit(0);
			}
		}
	} else if (logLine.match(/bind: permission denied/)) {
		timeLog(chalk.red(`Permission denied to bind ${chalk.cyan(pod.name)} on port ${chalk.magenta(pod.port)}`));
		process.exit(0);
	} else {
		if (!pod.initialized) {
			// must be true error message
			timeLog(chalk.red(`Failed to initialize port forwarding for ${chalk.cyan(pod.name)} on port ${chalk.magenta(pod.port)}: \n`));
			console.log(logLine);
			process.exit();
		} else {
			timeLog(`${chalk.blue(pod.name)}: ` + logLine);
		}
	}
}

try {
	const args = process.argv.slice(2);
	let podsToExclude = [];
	let podsToForward = [];
	let healthInterval = 5000;

	let snarf = null;

	args.forEach(arg => {
		if (snarf) { // next argument belongs to this function
			snarf(arg);
			snarf = null;
		} else if (arg.match(/--kubeconfig=[^\s]*?/)) {
			kubeConfig = arg.split('=')[1];
		} else if (arg === '--kubeconfig') {
			snarf = function (kc) {
				kubeConfig = kc
			};
		} else if (arg.match(/--namespace=[a-zA-z]*?/)) {
			namespace = arg.split('=')[1];
		} else if (arg === '--namespace') {
			snarf = function (ns) {
				namespace = ns;
			};
		} else if (arg.match(/--exclude=(?:[\-a-zA-Z]*,?)*/)) {
			podsToExclude = arg.split('=')[1].split(',').map((pod) => pod.trim());
		} else if (arg.match(/--health-interval=[\d]*?/)) {
			healthInterval = arg.split('=')[1];
		} else if (arg === '--help' || arg === '-help' || arg === '?' || arg == 'help') {
			console.log('kubectlpf:' +
				`
--kubeconfig config-file - override using ~/.kube/config
--namespace namespace - override the namespace in the kubernetes config file
--exclude=pods - comma separated values of pods to exclude from forwarding
--health-interval=ms - ms time interval between health check, e.g. 5000 is 5 seconds (default)`)
		} else {
			podsToForward.push(arg);
		}
	});

	if (!podsToForward.length) {
		if (!_.isEmpty(localDefinedPods)) {
			timeLog('Forwarding ports for pods from pods.json');
			podsToForward = Object.keys(localDefinedPods);
		} else {
			throw 'No pod names provided';
		}
	}

	const getPodName = (podName) => {
		if (systemDefinedPods[podName]) {
			return podName;
		} else {
			const possiblePods = Object.keys(systemDefinedPods).filter(pod => pod.toLowerCase().startsWith(podName.toLowerCase()));
			if (possiblePods.length == 1) {
				return possiblePods[0];
			} else {
				if (possiblePods.length > 1) {
					throw `More than one pod name matches ${chalk.cyan(podName)}: ${chalk.cyan(possiblePods)}`;
				} else {
					return false;
				}
			}
		}
	};

	const getPodMeta = (podName) => {
		let podPort;
		let fullPodName;
		const split = podName.split(':');
		if (split.length > 1) {
			fullPodName = split[0];
			podPort = split[1];
		} else {
			fullPodName = getPodName(podName);
			if (!fullPodName) {
				throw `Please specify port for ${chalk.cyan(podName)}`;
			}
			podPort = systemDefinedPods[fullPodName];
		}
		return {
			name: fullPodName,
			port: podPort
		}
	};

	podsToExclude = podsToExclude.map(pod => {
		const podMeta = getPodName(pod);
		if (!podMeta) {
			throw `Unknown pod to exclude: ${chalk.cyan(pod)}`;
		} else {
			return podMeta;
		}
	});

	podsToForward.forEach((podName) => {
		const podMeta = getPodMeta(podName);
		if (podsToExclude.indexOf(podMeta.name) !== -1) {
			return;
		}
		runningPods.push(podMeta);
	});

	if (runningPods.length == 0) {
		throw 'No pod names provided';
	}

	timeLog('Initializing...');

	if (kubeConfig) {
		timeLog(`Using config ${kubeConfig}`);
	}

	if (namespace) {
		timeLog(`Using namespace ${namespace}`);
	}

	const formalInit = () => {
		getPods(function (error, rawPods) {
			try {
				if (!error) {
					runningPods.forEach((pod, key) => {
						runningPods[key].id = getPodId(rawPods, pod.name, false);
					});
					runningPods.forEach((pod) => {
						portForwardPod(pod);
					});
					setInterval(healthCheck, healthInterval);
				} else {
					setTimeout(formalInit, healthInterval);
				}
			} catch (error) {
				timeLog(chalk.red(error));
			}
		});
	};

	formalInit();

} catch (error) {
	timeLog(chalk.red(error));
}

process.on('exit', () => {
	runningPods.forEach((pod) => {
		try {
			pod.childProcess.kill();
		} catch (error) {

		}
	})
});
