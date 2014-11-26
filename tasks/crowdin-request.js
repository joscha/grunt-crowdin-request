/*
 * grunt-crowdin-request
 * https://github.com/cloakedninjas/grunt-crowdin-request
 *
 * Copyright (c) 2014 Daniel Jackson
 * Licensed under the MIT license.
 */

'use strict';

module.exports = function(grunt) {

  var fs = require('fs');
  var request = require('request');
  var Promise = require('bluebird');
  var requestPromise = Promise.promisify(request);
  var unzip = require('unzip');

  grunt.registerMultiTask('crowdin-request', 'Upload a .pot file to crowdin.net', function() {

    var crowdin = new Crowdin({
      endpointUrl: 'https://api.crowdin.com/api',
      apiKey: this.options()['api-key'],
      projectIndentifier: this.options()['project-identifier']
    });

    var done = this.async();
    var self = this;

    switch (this.target) {
      case 'upload':
        var config = {
          options: this.options(),
          uploadOptions: this.data
        };

        var remoteFilename;

        crowdin.getUploadFilename(config)
          .then(function (filename) {
            remoteFilename = filename;
            return crowdin.getStatus();
          })
          .then(function (translationStatus) {
            return crowdin.getUpdateEndpoint(remoteFilename, translationStatus);
          })
          .then(function (apiMethod) {
            crowdin.uploadTranslations(apiMethod, remoteFilename, config);
          });

        break;

      case 'download':
        crowdin.export()
          .then(function (response) {
            grunt.verbose.writeln('Crowdin export result: ', response.success);
          })
          .then(function () {
            crowdin.unzipTranslations(self.data.outputDir);
          })
          .catch(Error, function (e) {
            grunt.fail.fatal(e);
          });

        break;

      default:
        grunt.fail.warn('Unknown job: ' + this.target);
        done(false);
    }
  });

  /**
   * Crowdin interaction class partly taken from https://github.com/hailocab/crowdin-node
   *
   * @param {object} config
   * @constructor
   */
  function Crowdin (config) {
    this.config = config || {};

    if (!this.config.apiKey) throw new Error('Missing apiKey');
    if (!this.config.endpointUrl) throw new Error('Missing endpointUrl');
  }

  /**
   *
   * @param {Object} config
   * @returns {Promise}
   */
  Crowdin.prototype.getUploadFilename = function (config) {
    var gitPattern = '#GIT_BRANCH#';

    return new Promise(function(resolve) {
      if (config.uploadOptions.filename.indexOf(gitPattern) !== -1) {
        var git = require('git-rev');

        // get the current branch name from Git
        git.branch(function (branchName) {
          grunt.verbose.writeln('Detected git branch: ' + branchName);

          resolve(config.uploadOptions.filename.replace(gitPattern, branchName));
        })
      }
      else {
        resolve(config.uploadOptions.filename);
      }
    });
  };

  /**
   *
   * @returns {Promise}
   */
  Crowdin.prototype.getStatus = function () {
    return this.getRequest('info');
  };

  /**
   *
   * @param {String} remoteFilename
   * @param {Object} translationStatus
   * @returns {Promise}
   */
  Crowdin.prototype.getUpdateEndpoint = function (remoteFilename, translationStatus) {

    return new Promise(function(resolve) {

      var apiMethod = 'add-file';

      for (var i = 0, len = translationStatus.files.length; i < len; i++) {
        if (translationStatus.files[i].name === remoteFilename) {
          apiMethod = 'update-file';
          break;
        }
      }

      resolve(apiMethod);
    });
  };

  /**
   *
   * @param action
   * @returns {string}
   */
  Crowdin.prototype.formUrl = function (action) {
    return this.config.endpointUrl + '/project/' + this.config.projectIndentifier + '/' + action;
  };

  /**
   *
   * @param params
   * @returns {Promise}
   */
  Crowdin.prototype.requestData = function (params) {
    return requestPromise(params)

      // Catch response errors
      .then(function (res) {
        if (!res || !res[0]) {
          throw new Error('No response');
        }

        if (res[0].statusCode >= 400) {
          grunt.log.error('Request failed: ' + res[1]);
          throw new Error(res[1]);
        }

        return res[1]; // Return response body
      })

      // Parse JSON
      .then(function (body) {
        if (body) return JSON.parse(body);
        return {};
      })

      // Throw error if present
      .then(function (data) {
        if (data.error) {
          throw new Error(data.error.message);
        }
        else {
          return data;
        }
      });
  };

  /**
   *
   * @param {String} uri
   * @returns {Promise}
   */
  Crowdin.prototype.getRequest = function (uri) {
    var url = this.formUrl(uri);
    grunt.verbose.writeln('Making GET request to: ' + url);

    return this.requestData({
      uri: url,
      method: 'GET',
      qs: {
        key: this.config.apiKey,
        json: 'json'
      }
    });
  };

  /**
   *
   * @param {String} uri
   * @param {Object} formData
   * @returns {Promise}
   */
  Crowdin.prototype.postRequest = function (uri, formData) {
    var url = this.formUrl(uri);
    grunt.verbose.writeln('Making POST request to: ' + url);

    return this.requestData({
      uri: url,
      method: 'POST',
      formData: formData,
      qs: {
        json: 'json',
        key: this.config.apiKey
      }
    });
  };

  /**
   *
   * @returns {Promise}
   */
  Crowdin.prototype.export = function () {
    return this.getRequest('export');
  };

  /**
   *
   * @returns {String}
   */
  Crowdin.prototype.download = function () {
    var url = this.formUrl('download/all.zip') + '?key=' + this.config.apiKey;

    grunt.verbose.writeln('Downloading translations from: ' + url);

    return request.get(url);
  };

  /**
   *
   * @param {Stream} toStream
   * @returns {Promise}
   */
  Crowdin.prototype.downloadToStream = function (toStream) {
    var that = this;
    return new Promise(function(resolve, reject) {
      that.download()
        .pipe(toStream)
        .on('error', reject)
        .on('close', resolve)
        .on('end', resolve);
    });
  };

  /**
   *
   * @param {String} toPath
   * @returns {Promise}
   */
  Crowdin.prototype.unzipTranslations = function (toPath) {
    return this.downloadToStream(unzip.Extract({path: toPath}));
  };

  /**
   *
   * @param {String} apiMethod
   * @param {String} remoteFilename
   * @param {Object} config
   * @returns {Promise}
   */
  Crowdin.prototype.uploadTranslations = function (apiMethod, remoteFilename, config) {
    var formData = {};
    formData['files[' + remoteFilename + ']'] = fs.createReadStream(config.uploadOptions.srcFile);

    return this.postRequest(apiMethod, formData);
  }
};