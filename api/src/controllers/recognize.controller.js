const perf = require('execution-time')();
const { v4: uuidv4 } = require('uuid');
const process = require('../util/process.util');
const actions = require('../util/detectors/actions');
const notify = require('../util/notify/actions');
const time = require('../util/time.util');
const recognize = require('../util/recognize.util');
const frigate = require('../util/frigate.util');
const { jwt } = require('../util/auth.util');
const mqtt = require('../util/mqtt.util');
const { emit } = require('../util/socket.util');
const { BAD_REQUEST } = require('../constants/http-status');
const DETECTORS = require('../constants/config').detectors();
const { AUTH, FRIGATE, TOKEN } = require('../constants');

const { IDS, MATCH_IDS } = {
  IDS: [],
  MATCH_IDS: [],
};

let PROCESSING = false;

module.exports.test = async (req, res) => {
  const promises = [];
  for (const detector of DETECTORS) {
    promises.push(
      actions
        .recognize({ detector, test: true, key: `${__dirname}/../static/img/lenna.jpg` })
        .catch((error) => {
          return { status: 500, data: error.message };
        })
    );
  }
  const results = await Promise.all(promises);
  const output = results.map((result, i) => ({
    detector: DETECTORS[i],
    status: result.status,
    response: result.data,
  }));
  res.send(output);
};

module.exports.start = async (req, res) => {
  try {
    let event = {
      type: req.method === 'POST' ? 'frigate' : req.query.type,
      options: {
        break: req.query.break,
        results: req.query.results,
        attempts: req.query.attempts || null,
      },
    };

    if (event.type === 'frigate') {
      const { type: frigateEventType, topic } = req.body;
      const attributes = req.body.after ? req.body.after : req.body.before;
      const { id, label, camera, current_zones: zones } = attributes;
      event = { id, label, camera, zones, frigateEventType, topic, ...event };
    } else {
      const { url, camera } = req.query;

      event = { id: uuidv4(), url, camera, zones: [], ...event };
    }

    const { id, camera, zones, url } = event;
    const { break: breakMatch, results: resultsOutput, attempts: manualAttempts } = event.options;

    if (!DETECTORS.length) return res.status(BAD_REQUEST).error('no detectors configured');

    if (event.type === 'frigate') {
      const check = await frigate.checks({
        ...event,
        PROCESSING,
        IDS,
      });
      if (check !== true) {
        console.verbose(check);
        return res.status(BAD_REQUEST).error(check);
      }
    }

    console.log(`processing ${camera}: ${id}`);
    perf.start('request');
    PROCESSING = true;

    const promises = [];

    const config = {
      breakMatch,
      id,
      MATCH_IDS,
    };

    if (event.type === 'frigate') {
      if (FRIGATE.ATTEMPTS.LATEST)
        promises.push(
          process.polling(
            { ...event },
            {
              ...config,
              retries: FRIGATE.ATTEMPTS.LATEST,
              type: 'latest',
              url: `${frigate.topicURL(event.topic)}/api/${camera}/latest.jpg?h=${
                FRIGATE.IMAGE.HEIGHT
              }`,
            }
          )
        );
      if (FRIGATE.ATTEMPTS.SNAPSHOT)
        promises.push(
          process.polling(
            { ...event },
            {
              ...config,
              retries: FRIGATE.ATTEMPTS.SNAPSHOT,
              type: 'snapshot',
              url: `${frigate.topicURL(event.topic)}/api/events/${id}/snapshot.jpg?h=${
                FRIGATE.IMAGE.HEIGHT
              }`,
            }
          )
        );
    } else {
      promises.push(
        process.polling(
          { ...event },
          {
            ...config,
            retries: parseInt(manualAttempts, 10),
            type: event.type,
            url,
          }
        )
      );
    }

    const { best, misses, unknown, results, attempts } = recognize.normalize(
      await Promise.all(promises)
    );

    const duration = parseFloat((perf.stop('request').time / 1000).toFixed(2));
    const output = {
      id,
      duration,
      timestamp: time.current(),
      attempts,
      camera,
      zones,
      matches: best,
      misses,
    };
    if (unknown && Object.keys(unknown).length) output.unknown = unknown;
    if (AUTH) output.token = jwt.sign({ route: 'storage', expiresIn: TOKEN.IMAGE });

    if (resultsOutput === 'all') output.results = results;

    console.log(`done processing ${camera}: ${id} in ${duration} sec`);

    const loggedOutput = JSON.parse(JSON.stringify(output));
    ['matches', 'misses'].forEach((type) =>
      loggedOutput[type].forEach((result) => delete result.base64)
    );
    if (loggedOutput.unknown) delete loggedOutput.unknown.base64;
    console.log(loggedOutput);

    PROCESSING = false;

    res.send(output);

    mqtt.recognize(output);
    notify.publish(output, camera, results);
    if (output.matches.length) IDS.push(id);
    if (results.length) emit('recognize', true);
  } catch (error) {
    PROCESSING = false;
    res.send(error);
  }
};