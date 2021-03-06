'use strict';
// Result comparison tests to be run by NodeJS/JSDOM test runner
var jsonTests = {
  reviews: retrieveReviews,
  ratings: retrieveRatings
};

if (typeof init === 'undefined')
  var init = false;

// For execution in browser
if (typeof chrome !== 'undefined' && !init)
  setupExtensionEvents();

function setupExtensionEvents() {
  chrome.runtime.onMessage.addListener(request => {
    if (request.action == 'retrieve') {
      if (!loggedIn()) {
        chrome.runtime.sendMessage({
          action: 'notice-login'
        });
        return false;
      }
      let datasets = {};
      datasets.schemaKey = request.schema.schema.key;
      datasets.schemaVersion = request.schema.schema.version;
      retrieveReviews(reviews => {
        datasets.reviews = new DataSet(reviews, request.schema.reviews).set;
        retrieveRatings(ratings => {
          datasets.ratings = new DataSet(ratings, request.schema.ratings).set;
          chrome.runtime.sendMessage({
            action: 'dispatch',
            data: datasets,
            schema: request.schema
          });
        }, reviews.head);
      });
    }
  });
  // Prevent repeated initialization
  init = true;
}

function loggedIn() {
  return !($('#nblogin').text());
}

// When running in an extension context, we can usually just look at the page
// we're on to find the profile URL. When running in Node, we need to get at
// least one IMDB page first to extract it. This is also a nice fallback for
// pages which don't have the profile link on them (e.g., error pages).
function getHead(callback) {
  let head = extractHeadInfo();
  let mainURL = 'http://www.imdb.com/';
  if (head) {
    callback(head);
  } else {
    $.get(mainURL)
      .done(function(html) {
        let doc = $.parseHTML(html);
        head = extractHeadInfo(doc);
        if (head)
          callback(head);
        else
          plugin.reportError('Could not find your IMDB profile.');
      })
      .fail(plugin.handleConnectionError(mainURL));
  }
}

// Extract a link to the user's profile from an IMDB page.
// Factored out so we can call it on current page or another; expects DOM element
// or array of them ($.parseHTML produces the latter).
function extractHeadInfo(pageDocument) {
  if (!pageDocument)
    pageDocument = document;

  let mainPart = 'http://www.imdb.com';
  // Strips off query string
  let profileLink = $(pageDocument).find('#nb_personal a').first().attr('href') || '';
  let reviewerID = (profileLink.match(/\/user\/(ur[0-9]+)/) || [])[1];
  let reviewerName = $(pageDocument).find('#consumer_user_nav a').first().text().trim();

  let head = {
    reviewerID,
    reviewerName
  };
  // Reviewer name is optional; reviewer ID is required for successful operation
  return reviewerID ? head : null;
}

function retrieveReviews(callback) {
  let page = 1;
  let reviews = {
    head: {},
    data: []
  };
  let doneURLs = [];

  getHead(head => {
    reviews.head = head;
    let firstURL = `http://www.imdb.com/user/${head.reviewerID}/comments-expanded`;
    doneURLs.push(firstURL);
    plugin.report('Fetching reviews &hellip;');
    $.get(firstURL)
      .done(processPage)
      .fail(plugin.handleConnectionError(firstURL));

    function processPage(html) {
      try {
        let $dom = $($.parseHTML(html));
        while ($dom.find('table#outerbody div').length) {
          let subject = $dom
            .find('table#outerbody div a')
            .first()
            .text();
          let subjectIMDBURL = 'http://www.imdb.com' + $dom
            .find('table div a')
            .first()
            .attr('href');
          let reviewScope = $dom
            .find('table div')
            .first()
            .nextUntil('div,hr');
          let title = reviewScope.closest('b')
            .first()
            .text();
          // "<small>x of y people found the following review useful:</small>" is only present where y > 0
          let date = reviewScope.closest('small').length == 1 ? $(reviewScope.closest('small')[0]).text() :
            $(reviewScope.closest('small')[1]).text();

          date = plugin.getISODate(date);

          let spoilers = reviewScope.find('b').length ? true : false;
          // We don't want spoiler warnings in the actual text.
          reviewScope = reviewScope.not('p:has(b)');

          let text = '';
          reviewScope.closest('p').each((i, e) => {
            if (e.innerHTML)
              text += `<p>${e.innerHTML}</p>`;
          });

          let altText = reviewScope
            .closest('img')
            .attr('alt') || '';
          let starRating = (altText.match(/(\d+)\//) || [])[1];
          // Remove processed bits so the while loop can continue
          $dom
            .find('table#outerbody div')
            .first()
            .nextUntil('div')
            .remove();
          $dom
            .find('table#outerbody div')
            .first()
            .remove();
          let reviewObj = {
            subject,
            subjectIMDBURL,
            title,
            date,
            text,
            starRating,
            spoilers
          };
          reviews.data.push(reviewObj);
        }
        let nextLink = $dom
          .find('table table td a img')
          .last()
          .parent()
          .attr('href');
        let nextURL = nextLink ?
          `http://www.imdb.com/user/${reviews.head.reviewerID}/${nextLink}` :
          undefined;

        if (nextURL && doneURLs.indexOf(nextURL) === -1) {
          doneURLs.push(nextURL);
          page++;
          // Obtain and relay progress info
          let totalPages = ($dom
            .find('table td font')
            .first()
            .text()
            .match(/\d+.*?(\d+)/) || [])[1];
          let progress = `Fetching page ${page} of ${totalPages} &hellip;`;
          plugin.report(progress);
          // Fetch next page
          $.get(nextURL)
            .done(processPage)
            .fail(plugin.handleConnectionError(nextURL));
        } else {
          callback(reviews);
        }
      } catch (error) {
        plugin.reportError(`An error occurred processing your reviews.`, error.stack);
      }
    }
  });
}

function retrieveRatings(callback, head) {
  if (head === undefined) {
    getHead(head => {
      retrieveRatings(callback, head);
    });
    return;
  }
  let ratings = {
    head,
    data: []
  };
  let csvURL = `http://www.imdb.com/list/export?list_id=ratings&author_id=${head.reviewerID}`;
  plugin.report('Fetching ratings &hellip;');
  Papa.parse(csvURL, {
    download: true,
    header: true,
    skipEmptyLines: true,
    complete: function(results) {
      let filteredResults = results.data.filter(ele => {
        return ele.URL || ele.Title;
      });
      ratings.data = filteredResults.map(ele => {
        // We're using only the parts of the CSV which are the user's own work.
        // The CSV also contains a "modified" date, which does not appear to
        // be used, see: https://getsatisfaction.com/imdb/topics/gobn1q01nbd5o
        //
        // The column "You rated" is called "<reviewerName> rated" for someone
        // else's CSV. We try either just in case.
        return {
          starRating: ele['You rated'] || ele[head.reviewerName + ' rated'],
          subject: ele.Title,
          subjectIMDBURL: ele.URL,
          datePosted: plugin.getISODate(ele.created) || undefined
        };
      });
      callback(ratings);
    },
    error: plugin.handleConnectionError(csvURL)
  });
}
