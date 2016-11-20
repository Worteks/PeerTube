// For vendors for example jQuery, Lodash, angular2-jwt just import them here unless you plan on
// chunking vendors files for async loading. You would need to import the async loaded vendors
// at the entry point of the async loaded file. Also see custom-typings.d.ts as you also need to
// run `typings install x` where `x` is your module

// Angular 2
import '@angular/platform-browser';
import '@angular/platform-browser-dynamic';
import '@angular/core';
import '@angular/common';
import '@angular/forms';
import '@angular/http';
import '@angular/router';

import '@angularclass/hmr';

// RxJS
import 'rxjs/Observable';
import 'rxjs/Subject';
import 'rxjs/ReplaySubject';
import 'rxjs/add/operator/catch';
import 'rxjs/add/operator/mergeMap';
import 'rxjs/add/operator/map';
import 'rxjs/add/observable/throw';

import 'bootstrap-loader';

import 'angular-pipes/src/math/bytes.pipe';
import 'ng2-file-upload';
import 'video.js';
import 'ng2-meta';
import 'ng2-bootstrap/components/pagination';
import 'ng2-bootstrap/components/dropdown';
import 'ng2-bootstrap/components/progressbar';
import 'ng2-bootstrap/components/modal';
