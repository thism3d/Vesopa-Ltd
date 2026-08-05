const gulp = require("gulp");
const sass = require("gulp-sass")(require("sass"));
const autoprefixer = require("gulp-autoprefixer");
const cleanCSS = require("gulp-clean-css");
const babel = require("gulp-babel");
const browserSync = require("browser-sync").create();

// Customize this to your WHMCS child theme name
const themeFolder = "whmcs-starter";

// Compile SCSS to CSS
function styles() {
	return gulp
		.src("src/scss/style.scss")
		.pipe(sass().on("error", sass.logError))
		.pipe(autoprefixer())
		.pipe(cleanCSS())
		.pipe(gulp.dest("assets/css"))
		.pipe(browserSync.stream());
}

// Compile and Minify JS
function scripts() {
	return gulp
		.src("src/js/**/*.js")
		.pipe(
			babel({
				presets: ["@babel/preset-env"],
			})
		)
		.pipe(gulp.dest("assets/js"))
		.pipe(browserSync.stream());
}

function serve(done) {
	browserSync.init({
		proxy: "http://localhost:8888/whmcs/",
		files: [
			`/Applications/MAMP/htdocs/whmcs/templates/${themeFolder}/**/*.tpl`,
			"assets/css/*.css",
			"assets/js/*.js",
		],
		notify: false,
	});
	done();
}

function watch() {
	gulp.watch("src/scss/**/*.scss", styles);
	gulp.watch("src/js/**/*.js", scripts);
	gulp.watch(`/Applications/MAMP/htdocs/whmcs/templates/${themeFolder}/**/*.tpl`).on(
		"change",
		function (path) {
			console.log(`Reloading due to: ${path}`);
			browserSync.reload();
		}
	);
}

exports.styles = styles;
exports.scripts = scripts;
exports.serve = serve;
exports.watch = watch;
exports.default = gulp.series(styles, scripts, serve, watch);
