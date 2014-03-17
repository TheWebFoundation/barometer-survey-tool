var CLIENT_ID = '830533464714-j7aafbpjac8cfgmutg83gu2tqgr0n5mm.apps.googleusercontent.com';
var SCOPE = 'https://spreadsheets.google.com/feeds https://www.googleapis.com/auth/drive';

// Gimme a range op!
Array.prototype.range = function(n) {
	return Array.apply(null, Array(n)).map(function (_, i) {return i;});
}

angular.module('W3FWIS', [ 'GoogleSpreadsheets', 'ngCookies', 'ngRoute', 'ngSanitize' ])
	// Setup route. There's only one route, and it's /<answerSheetKey>
	.config([ '$routeProvider', '$locationProvider', function($routeProvider, $locationProvider) {
		$routeProvider.when('/:answerKey?', {
			controller: 'W3FSurveyController',
			templateUrl: 'tpl/survey.html'
		});

		$locationProvider.html5Mode(true);
	} ])

	// Create "country" filter
	.filter('country', [ '$rootScope', function( $rootScope ) {
		return function(input) {
			return input.replace('[country]', $rootScope.country);
		}
	} ])

	// Create "markdown" filter
	.filter('markdown', function( $rootScope ) {
		return function(input) {
			return markdown.toHTML(input);
		}
	})

	// Top-level controller
	.controller('W3FSurveyController', [ 'spreadsheets', '$scope', '$rootScope', '$q', '$cookies', '$routeParams', '$interval', function(gs, $scope, $rootScope, $q, $cookies, $routeParams, $interval) {
		var masterKey = '0AokPSYs1p9vhdEdjeUluaThWc2RqQnI0c21oN1FaYUE';
		var answerKey = $routeParams.answerKey;
		var answerSheet, noteSheet;

		// Who's doing the Survey? Determined by answer sheet, defaults to "Anonymous"
		$rootScope.participant = "Anonymous";

		// Section order and descriptors
		$rootScope.sectionOrder = [];
		$rootScope.sections = {};

		// Questions by Section ID
		$rootScope.questions = {};

		// Responses by question ID, as a watched scope model
		$rootScope.responses = {};

		// We're loading... !
		$rootScope.loading = true;

		// Notes by Question ID
		$rootScope.notes = {};

		// Anonymous until proven otherwise
		$rootScope.anonymous = true;

		// Links to answer sheet rows by question id
		$rootScope.links = {
			responses: {},
			notes: {}
		};

		// Set up an initial page
		$rootScope.activeSection = $cookies.section;

		// Navigate to a different section
		$rootScope.navigate = function(section) {
			$rootScope.activeSection = $cookies.section = section;
			window.scrollTo(0,0);
		}

		//
		// Manage updating the answer sheet 
		// 

		// Queue up changes as responses or notes are updated
		var queue = {
			responses: {},
			notes: {}
		};
		
		// Keep timers for processes here, cancelling pending changes to an update process
		// when newer changes have occured
		var processQueue = {
			responses: {},
			notes: {}
		};

		// Three-second timer
		$interval(function() {
			var size = 0;

			// Process a queue for the two sections
			_.each([ 'responses', 'notes' ], function(section) {
				_.each(queue[section], function(response, qid) {
					var q = queue[section];
					var pq = processQueue[section];

					var links = $rootScope.links[section];
					var values = $rootScope[section][qid];

					if(pq[qid]) {
						_.each(pq[qid], function(q) { q.abort(); });
					}

					pq[qid] = [];

					if(section == 'responses') {
						// Only a single row here
						values = $.extend({}, {
							response: values.response, 
							 justification: values.justification,
							 confidence: values.confidence,
							 examples: values.examples,
						}, { 
							questionid: qid
						});

						if(links[qid]) {
							pq[qid] = [ gs.updateRow(links[qid].edit, values, $rootScope.accessToken) ];
						}
						else {
							pq[qid] = [ gs.insertRow(answerSheet, values, $rootScope.accessToken) ];
						}
					}
					else {
						_.each(_.filter(values, function(v) { return v.create; }), function(note) {
							var values = {
								questionid: note.questionid,
								date: (function(d) { return d.toDateString() + ", " + d.toLocaleTimeString() })(new Date()),
								party: $rootScope.participant,
								field: note.field,
								note: note.note
							};

							pq[qid].push(gs.insertRow(noteSheet, values, $rootScope.accessToken).then(function(row) { delete note.create; return row; }));
						});
					}
					
					_.each(pq[qid], function(ppq) {
						size++;
						ppq.then(function(row) {
							links[qid] = row[':links'];

							size--;

							if(size == 0) {
								$rootScope.status = {
									message: "Last saved " + (function(d) { return d.toDateString() + ", " + d.toLocaleTimeString() })(new Date()),
									success: true,
									clear: 3000
								};
							}
						}, function(message) {
							$rootScope.status = {
								error: "Failed to save changes" 
							};
						});
					});
				});

				queue[section] = {};
			});

			if(size) {
				$rootScope.status = {
					saving: size
				}
			}
		}, 3000);

		var populate = function(sheets) {
			var deferred = $q.defer();

			// Populate "Sections" from sections sheet
			var populateSections = function(rows) {
				angular.forEach(rows, function(section) {
					$rootScope.sectionOrder.push(section.section);

					// Default to first section
					if(!$rootScope.activeSection) {
						$rootScope.activeSection = section.section;
					}

					$rootScope.sections[section.section] = section;
					$rootScope.sections[section.section].questions = [];
				});
			};

			// Populate "Questions" from questions sheet
			var populateQuestions = function(rows) {
				angular.forEach(rows, function(question) {
					if(!$rootScope.sections[question.section]) {
						return;
					}

					// Gather various fields into arrays. Original fields are kept, this is just for ease of templates
					angular.forEach([ 'option', 'guidance', 'supporting' ], function(field) {
						question[field] = [];

						for(var i = 0; i <= 10; i++) {
							var id = field + i;

							if(typeof question[id] == 'string' && question[id] != '' ) {
								question[field].push({ weight: i, id: id, content: question[id] });
							}
						}
					});

					// Extract valid options from supporting information fields
					angular.forEach(question.supporting, function(option) {
						var matches = option.content.match(/^\s*(?:(\d+(?:\s*,\s*\d+)*)\s*;)?\s*(.+)\s*$/i);

						option.values = matches[1] && matches[1].split(/\s*,\s*/);
						option.content = matches[2];
					});

					// Put responses here. Initialize with blank response
					$rootScope.responses[question.questionid] = {
						questionid: question.questionid,
						response: '',
					};

					// Put notes here.
					$rootScope.notes[question.questionid] = [];
					
					// Update progress bar as responses are given
					$rootScope.$watchCollection('responses["' + question.questionid + '"]', function(newValue) {
						$rootScope.$broadcast('response-updated', newValue);
					});

					// Nest subquestions here
					question.subquestions = [];

					// Save a reference to the question by ID
					$rootScope.questions[question.questionid] = question;

					// Child questions, assume parent has already been registered.
					if(question.parentid) {
						$rootScope.questions[question.parentid].subquestions.push(question);
					}
					// Top-level question in this section
					else {
						$rootScope.sections[question.section].questions.push(question);
					}
				});
			}

			// Load answer sheet and populate responses model
			var loadAnswers = function() {
				// Try to get answer sheet
				gs.getSheets(answerKey, $rootScope.accessToken).then(function(sheets) {
					if(!sheets['Control']) {
						$rootScope.error = "Couldn't find control sheet";
						return;
					}

					if(!sheets['Answers']) {
						$rootScope.error = "Couldn't find answers sheet";
						return;
					}

					// Get any answer metadata from control sheet
					gs.getRows(answerKey, sheets['Control'], $rootScope.accessToken).then(function(config) {
						if(config.length == 0) {
							$rootScope.error = "Couldn't determine country!";
						}

						// TODO: Verify user's role here based on Control sheet comparison of hashed IDs
						$rootScope.anonymous = false;

						$rootScope.country = config[0].country;
					});

					answerSheet = sheets['Answers'];

					// Populate answers. This can be done in parralel with control data load
					// since the data sets are distinct
					gs.getRows(answerKey, answerSheet, $rootScope.accessToken).then(function(answers) {
						angular.forEach(answers, function(answer) {
							if(!$rootScope.questions[answer.questionid]) {
								console.log("Answer with qid=" + answer.questionid + " does not correspond to any survey question");
								return;
							}

							$rootScope.links.responses[answer.questionid] = answer[':links'];

							var response = $rootScope.responses[answer.questionid]; 

							// Copy all response properties from sheet into row
							for(var col in answer) {
								// Ignore metadata fields starting with :
								if(col[0] != ':') {
									response[col] = answer[col];
								}
							}

							// Collapse multi-part responses into arrays
							angular.forEach([ 'example' ], function(field) {
								answer[field] = [];

								for(var i = 0; i <= 10; i++) {
									var id = field + i;

									if(typeof answer[id] == 'string' && answer[id] != '' ) {
										answer[field].push(answer[id]);
									}
								}
							});
						});

						// Only now that the answer sheet has been loaded
						// do we watch for changes to the responses that might
						// come from the user.
						//
						// Watch responses to add any changes to the save queue
						//
						// BUG: oldValue and newValue are the same in this call from $watchCollection -
						// See: https://github.com/angular/angular.js/issues/2621. 
						_.each(_.keys($rootScope.questions), function(qid) {
							$rootScope.$watch("responses['" + qid + "']", function(oldValue, newValue) {
								if(oldValue !== newValue) {
									queue.responses[qid] = newValue;
								}
							}, true);

							// Also watch for changes in notes collections
							$rootScope.$watch("notes['" + qid + "']", function(oldValue, newValue) {
								if(oldValue !== newValue) {
									console.log("NOTE!! ", newValue);
									queue.notes[qid] = newValue;
								}
							}, true);
						});

						deferred.resolve({
							message: "Loaded",
							success: true,
							clear: 3000,
						});
					});

					noteSheet = sheets['Notes'];

					// Populate notes for each question
					gs.getRows(answerKey, noteSheet, $rootScope.accessToken).then(function(rows) {
						angular.forEach(rows, function(note) {
							if(!$rootScope.notes[note.questionid]) {
								console.log("Note with qid=" + note.questionid + " does not correspond to any survey question");
								return;
							}

							$rootScope.links.notes[note.questionid] = note[':links'];

							$rootScope.notes[note.questionid].push(note);	
						});
					});

				});
			}

			$rootScope.loading = "Loading Sections...";
			gs.getRows(masterKey, sheets['Sections'], $rootScope.accessToken).then(function(sections) {
				populateSections(sections);

				$rootScope.loading = "Loading Questions...";
				gs.getRows(masterKey, sheets['Questions'], $rootScope.accessToken).then(function(questions) {
					populateQuestions(questions);

					if(answerKey) {
						$rootScope.loading = "Loading Answers...";

						loadAnswers();
					}
					else {	
						deferred.resolve({ 
							message: "You are taking this survey anonymously and changes will not be saved."
						});
					}
				});
			});

			return deferred.promise;
		};

		window.authenticated = function(authResult) {
			if(!authResult || authResult.error) {
				$rootScope.show_signin = true;
				return;
			}

			if(!authResult.status.signed_in || $rootScope.accessToken) {
				return;
			}

			$rootScope.accessToken = authResult.access_token;
			$rootScope.show_signin = false;

			$rootScope.loading = "Loading Survey...";

			// Get sheets in master sheet,
			gs.getSheets(masterKey, $rootScope.accessToken).then(function(sheets) {
				// Check for required 'Sections' sheet
				if(!sheets['Sections']) {
					$rootScope.loading = false;
					$rootScope.error = "Could't find 'Sections' sheet!";
					return;
				}

				// Load the survey
				populate(sheets).then(function(status) {
					$rootScope.status =	status;

					$rootScope.$broadcast('sections-loaded');
				}, function(error) {
					$rootScope.error = error
				})
				['finally'](function(status) {
					$rootScope.loading = false;
				});
			});
		};

		$rootScope.status = {
			message: "Loading..."
		}

		$rootScope.loading = "Authenticating...";
	} ])

	// Create a rail exactly the size of the sections menu
	.directive('withRail', [ '$timeout', function($timeout) {
		return {
			link: function($scope, element, attrs) {
				$scope.$on('sections-loaded', function() {
					$timeout(function() {
						var $sections = $('#sections');
						var $ul = $sections.find('ul');

						$sections.width($ul.width());
						$sections.height($ul.height());

						$(element).css('padding-left', $ul.width());
					}, 0, false);
				});
			}
		}
	} ])

	// Set sectionAnswers and sectionQuestions scope variables for a particular
	// section when a response is changed
	.directive('updateOnResponse', [ '$timeout', function($timeout) {
		return {
			link: function($scope, element, attrs) {
				$scope.$on('response-updated', function() {
					$scope.sectionAnswers = [];
					$scope.sectionQuestions = _.filter($scope.questions, function(q) { 
						if(q.section == $scope.section) {
							if($scope.responses[q.questionid].response != undefined && $scope.responses[q.questionid].response != '') {
								$scope.sectionAnswers.push($scope.responses[q.questionid]);
							}

							return true;
						}

						return false;
					});
				});
			}
		}
	} ])

	// Fade out an element based on 'clear' property of argument 
	.directive('fadeOn', [ '$timeout', function($timeout) {
		return {
			link: function($scope, element, attrs) {
				var timeoutPromise;

				$scope.$watch(attrs.fadeOn, function(val) {
					$timeout.cancel(timeoutPromise);

					if(!val) {
						return;
					}

					if(val.clear) {
						timeoutPromise = $timeout(function() {
							element.fadeOut(function() {
								element.addClass('ng-hide');
								element.css('display', '');
							});
						}, val.clear, 0)
					}
				}, true);
			}
		}
	} ])

	// Attach notes to a question. Evaluate argument then evaluate against $scope
	.directive('notes', [ '$rootScope', function($rootScope) {
		return {
			templateUrl: 'tpl/notes.html',
			restrict: 'E',
			scope: {},

			link: function($scope, element, attrs) {
				// Determine the expression within 'response' that refers to the field being noted
				$scope.field = $scope.$eval(attrs.field);
				$scope.particpant = $rootScope.participant;

				// Import scope variables
				$scope.question = $scope.$parent.question;

				var refreshNotes = function() {
					$scope.notes = _.filter( $rootScope.notes[$scope.question.questionid], function(note) { return note.field == $scope.field; });
				}

				refreshNotes();

				$rootScope.$watch('notes["' + $scope.question.questionid + '"]', refreshNotes, true);
				
				$scope.addNote = function() {
					$rootScope.notes[$scope.question.questionid].push({
						questionid: $scope.question.questionid,
						party: $rootScope.participant,
						field: $scope.field,
						note: $scope.newNote,
						create: true
					});

					$scope.newNote = '';
				}

				element.addClass('notable');

				$rootScope.$broadcast('close-notes');

				// Close notes when user clicks outside notes... TODO: Optimize. 
				// This Takes a long time for all notes boxes to receive this broadcast.
				$scope.$on('close-notes', function() {
					if($scope.opened) {
						$scope.opened = false;
					}
				});
			}
		}
	} ])

	.run([ '$rootScope', function($rootScope) {
		$(document).on('click', function(ev) {
			if($(ev.target).closest('.notes, .open-notes').length == 0) {
				$rootScope.$broadcast('close-notes');
			}
			if($(ev.target).closest('.fancy-select').length == 0) {
				$rootScope.$broadcast('close-popups');
			}
		});
	} ])

	// Drive a "sum" type question, which has for a value the sum of all
	// of its subquestion's responses
	.directive('sumQuestion', [ '$rootScope', function($rootScope) {
		return {
			link: function($scope, element, attrs) {
				var question = $scope.$eval(attrs.sumQuestion);
				
				// Update response when any child value changes
				var update = function() {
					function computeSum(questions) {
						var sum = 0;

						angular.forEach(questions, function(q) {
							var number = parseInt($scope.responses[q.questionid].response);

							if(!isNaN(number)) {
								sum += number;
							}

							if(q.subquestions && q.subquestions.length) {
								sum += computeSum(q.subquestions);
							}
						});

						return sum;
					}

					$rootScope.responses[question.questionid].response = computeSum(question.subquestions);
				}

				// Listen on all sub-question responses (and their subquestions)
				var listenRecursively = function(questions) {
					angular.forEach(questions, function(question) {
						$scope.$watch('responses["' + question.questionid + '"].response', update);
					});
				}

				listenRecursively(question.subquestions);
			}
		}
	} ])

	// Allow for insert/update/delete operations on a list of text inputs
	.directive('flexibleList', [ '$rootScope', function($rootScope) {
		return {
			templateUrl: 'tpl/flexible-list.html',
			restrict: 'E',

			link: function($scope, element, attrs) {
				// Force this model to be an array
				if(typeof $scope.$eval(attrs.ngModel) == 'undefined') {
					$scope.$eval(attrs.ngModel + '=[]');
				}

				$scope.list = $scope.$eval(attrs.ngModel);

				$scope.upload = function(upload) {
					var $scope = $(upload).scope();
					var $index = $(upload).parents('.flexible-list-item').index();

					var file = upload.files[0];

					if(!file) {
						console.log("File not found to upload!");
						return
					}

					const boundary = '-------314159265358979323846';
					const delimiter = "\r\n--" + boundary + "\r\n";
					const close_delim = "\r\n--" + boundary + "--";

					var reader = new FileReader();
					reader.readAsBinaryString(file);
					reader.onload = function(e) {
						var contentType = file.type || 'application/octet-stream';
						var metadata = {
							'title': file.name,
							'mimeType': contentType
						};

						var base64Data = btoa(reader.result);
						var multipartRequestBody =
								delimiter +
								'Content-Type: application/json\r\n\r\n' +
								JSON.stringify(metadata) +
								delimiter +
								'Content-Type: ' + contentType + '\r\n' +
								'Content-Transfer-Encoding: base64\r\n' +
								'\r\n' +
								base64Data +
								close_delim;

						var request = gapi.client.request({
								'path': '/upload/drive/v2/files',
								'method': 'POST',
								'params': {'uploadType': 'multipart'},
								'headers': {
									'Content-Type': 'multipart/mixed; boundary="' + boundary + '"'
								},
								'body': multipartRequestBody
						});

						$scope.uploadState = "Uploading...";

						request.execute(function(results) {
							$scope.uploadState = "Uploaded";
console.log(arguments);
						});
					}
				}

				$scope.$watch('list', function(newValue, oldValue) {
					$scope[attrs.ngModel] = newValue;
				});
			}
		}
	} ])

	// Fancy select box
	.directive('fancySelect', [ '$rootScope', '$timeout', function($rootScope, $timeout) {
		return {
			restrict: 'E',
			templateUrl: 'tpl/fancy-dropdown.html',
			replace: true,
			compile: function(element, attrs) {
				var $select = element.find('select');
				var selectedIndex = -1;

				_.each(_.clone(element[0].attributes), function(attr) {
					if(attr.name != 'class') {
						$select.attr(attr.name, attr.value);
						element.removeAttr(attr.name);
					}
				});

				if(attrs.withNull) {
					$select.append($('<option value="">').text(attrs.withNull));
					selectedIndex = 0;
				}

				return function($scope, element, attrs, transclude) {
					var $select = element.find('select');
					var $options = element.find('.fancy-select-options');

					$scope.selectedIndex = selectedIndex;

					// Keep a local model containing the select's <option>s
					//
					// The angular code for managing the select <option>s is turbly
					// complicated and it's best to just avoid having to use it at all,
					// use the DOM to notify of changes instead
					function update() {
						$scope.items = [];

						$select.find('option').each(function() {
							$scope.items.push(this.textContent);
						});

						// Measure the width of the widest item and set the drop-down's
						// width to that
						$timeout(function() {
							var $clone = $('<div class="fancy-select">');

							$clone.html(element.html());
							$clone.css('width', '');

							var	$dropdown = $clone.find('.fancy-select-options');

							$clone.css({ visibility: 'hidden', position: 'absolute', top: 0 });
							$dropdown.removeClass('ng-hide').css('display', 'block');
							$('body').append($clone);
							element.css({ width: $dropdown.outerWidth() });
							$clone.remove();
						}, 0);

						$scope.selectedIndex = $select[0].selectedIndex;
					}

					var lastOptions = [];

					$scope.$parent.$watch(function() {
						var options = _.map($select[0].options, function(option) {
							return [ option.value, option.textContent ];
						});

						if(!_.isEqual(options, lastOptions) || $select[0].selectedIndex != $scope.selectedIndex) {
							update();
							lastOptions = options;
						}
					});

					update();

					// Use the DOM to notify angular by just changing the value
					$scope.select = function(index) {
						$timeout(function() {
							$select[0].selectedIndex = index;
							$select.trigger('change');
						}, 0);

						$scope.opened = false;
						$scope.selectedIndex = index;
					}

					$scope.$on('close-popups', function() {
						if($scope.opened) {
							$scope.opened = false;
						}
					});
				}
			}
		}
	} ]);

window.gapi_loaded = function() {
	window.GAPI_LOADED = true;

	// Try to authenticate immediately
	gapi.auth.authorize({
		client_id: CLIENT_ID,
		scope: SCOPE,
		immediate: true
	}, window.authenticated);

	// Render the sign-in button
	gapi.signin.render(document.getElementById('signin-button'), {
		clientid: CLIENT_ID,
		scope: SCOPE,
		cookiepolicy: 'single_host_origin',
		callback: 'authenticated'
	});
};
