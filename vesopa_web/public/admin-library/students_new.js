

var loadFile = function(event) {
	var image = document.getElementById('student_profile_pic_form');
	image.src = URL.createObjectURL(event.target.files[0]);
};


var students_new_HTML =
`<div class="onchers_common_form_keeper">
	<form class="onchers_common_form" method="post" enctype="multipart/form-data"  action="add_students.php">


		<div class="onchers_common_form_header">
			<h2 class="onchers_common_form_heading">Student Registration</h2>
			<p class="onchers_common_form_head_info">Register your student</p>
		</div>


		<div class="onchers_form_item_container">
			<div class="onchers_form_item_picture">
				<img id="student_profile_pic_form" src="">
				<input type="file" "image/png, image/gif, image/jpeg, image/gif" name="fileToUpload" id="student_profile_input"  onchange="loadFile(event)" style="display: none;">
				<label class="image_input_label" for="student_profile_input" style="cursor: pointer;">Upload</label>
			</div>
		</div>


		<div class="onchers_form_item_container">
			<label class="onchers_common_form_label">Birthday</label>
			<input class="onchers_common_form_input" name="birthdate" type="date">
		</div>


		<div class="onchers_form_item_container">
			<label class="onchers_common_form_label">Full Name</label>
			<input class="onchers_common_form_input" name="fullname" type="text" placeholder="Student Full Name" minlength="3" required>
		</div>

		<div class="onchers_form_item_container">
			<label class="onchers_common_form_label">Display Name</label>
			<input class="onchers_common_form_input" name="display_name" type="text" placeholder="Student Platform Display Name" minlength="3" required>
		</div>

		<div class="onchers_form_item_container">
			<label class="onchers_common_form_label">Country</label>
			<select class="onchers_common_form_select" name="country" required>
				<option value="ZW">Zimbabwe</option>
			</select>
		</div>

		<div class="onchers_form_item_container">
			<label class="onchers_common_form_label">Current Location</label>
			<input class="onchers_common_form_input" name="current_location" type="text" placeholder="Student Current Location" minlength="5">
		</div>

		<div class="onchers_form_item_container">
			<label class="onchers_common_form_label">Gender</label>
			<select class="onchers_common_form_select" name="gender" required>
				<option value="Male" selected>Male</option>
				<option value="Female">Female</option>
			</select>
		</div>

		<div class="onchers_form_item_container">
			<label class="onchers_common_form_label">Age</label>
			<input class="onchers_common_form_input" name="age" type="number" min="2" step="1" max="100" placeholder="Student Age" required>
		</div>

		<div class="onchers_form_item_container">
			<label class="onchers_common_form_label">Type</label>
			<select class="onchers_common_form_select" name="type" required>
				<option value="Kid" selected>Kid</option>
				<option value="Adult">Adult</option>
				<option value="Business">Business</option>
				<option value="Client">Client</option>
				<option value="IELTS">IELTS</option>
				<option value="TOEFL">TOEFL</option>
			</select>
		</div>

		<div class="onchers_form_item_container">
			<label class="onchers_common_form_label">Status</label>
			<select class="onchers_common_form_select" name="status" required>
				<option value="Trial" selected>Trial</option>
				<option value="New">New</option>
				<option value="Regular">Regular</option>
				<option value="Package">Package</option>
			</select>
		</div>


		<div class="onchers_form_item_container">
			<label class="onchers_common_form_label">Notes</label>
			<textarea class="onchers_common_form_textarea" name="notes" type="text"  placeholder="Note about the student"></textarea>
		</div>


		<div class="onchers_form_item_container">
			<label class="onchers_common_form_label">Platform Type</label>
			<textarea class="onchers_common_form_textarea" name="platform_type" type="text"  placeholder="Platform Type"></textarea>
		</div>


		<div class="onchers_form_item_container">
			<input class="onchers_common_form_button" type="submit" value="Create">
		</div>


	</form>
</div>

`;

function approve_new_business(businessName, profileId){
	var welcome_text_update_form =
	`<div class="onchers_common_form_keeper">
		<form class="onchers_common_form" method="post" enctype="multipart/form-data"  action="approve_the_business.php">
	
	
			<div class="onchers_common_form_header">
				<h2 class="onchers_common_form_heading">Approve the Business `+ businessName +` </h2>
			</div>
	
	
		<input class="onchers_common_form_input" name="profile_id" type="hidden" placeholder="" value="`+ profileId +`" required>


			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">New Password</label>
				<input class="onchers_common_form_input" name="password" type="text"  placeholder="" minlength="7" required>
			</div>
	
	
	
			<div class="onchers_form_item_container">
				<input class="onchers_common_form_button" type="submit" value="Update">
			</div>
	
	
		</form>
	</div>
	
	`;
	return welcome_text_update_form;
}


function update_welcome_text_function(welcomeText){
	var welcome_text_update_form =
	`<div class="onchers_common_form_keeper">
		<form class="onchers_common_form" method="post" enctype="multipart/form-data"  action="forms/update_welcome_text.php">
	
	
			<div class="onchers_common_form_header">
				<h2 class="onchers_common_form_heading">Update Welcome Text</h2>
			</div>
	
	
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Welcome Text</label>
				<textarea class="onchers_common_form_textarea" name="data1" type="text"  placeholder="" required>`+ welcomeText +`</textarea>
			</div>
	
	
	
			<div class="onchers_form_item_container">
				<input class="onchers_common_form_button" type="submit" value="Update">
			</div>
	
	
		</form>
	</div>
	
	`;
	return welcome_text_update_form;
}



function update_overview_section(data1, data2, data3){
	var welcome_text_update_form =
	`<div class="onchers_common_form_keeper">
		<form class="onchers_common_form" method="post" enctype="multipart/form-data"  action="forms/update_overview_section.php">
	
			
			<div class="onchers_common_form_header">
				<h2 class="onchers_common_form_heading">Update Overview Section</h2>
			</div>


			<div class="onchers_form_item_container onchers_picture_center_keeper">
				<div class="onchers_form_item_picture">
					<img id="student_profile_pic_form" src="../assets/official/`+ data1 +`">
					<input type="file" "image/png, image/gif, image/jpeg, image/gif" name="fileToUpload" id="student_profile_input"  onchange="loadFile(event)" style="display: none;">
					<label class="image_input_label" for="student_profile_input" style="cursor: pointer;">Upload</label>
				</div>
			</div>

	
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Heading</label>
				<input class="onchers_common_form_input" name="data2" type="text" placeholder="" minlength="5" value="`+ data2 +`" required>
			</div>
	
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Description</label>
				<textarea class="onchers_common_form_textarea" style="min-height: 200px;" name="data3" type="text"  placeholder="" required>`+ data3 +`</textarea>
			</div>
	
	
	
			<div class="onchers_form_item_container">
				<input class="onchers_common_form_button" type="submit" value="Update">
			</div>
	
	
		</form>
	</div>
	
	`;
	return welcome_text_update_form;
}


function update_explore_section(data1, data2, data3, data4){
	var welcome_text_update_form =
	`<div class="onchers_common_form_keeper">
		<form class="onchers_common_form" method="post" enctype="multipart/form-data"  action="forms/update_explore_section.php">
	
			
			<div class="onchers_common_form_header">
				<h2 class="onchers_common_form_heading">Update Explore Section</h2>
			</div>


			<div class="onchers_form_item_container onchers_picture_center_keeper">
				<div class="onchers_form_item_picture">
					<img id="student_profile_pic_form" src="../assets/official/`+ data3 +`">
					<input type="file" "image/png, image/gif, image/jpeg, image/gif" name="fileToUpload" id="student_profile_input"  onchange="loadFile(event)" style="display: none;">
					<label class="image_input_label" for="student_profile_input" style="cursor: pointer;">Upload</label>
				</div>
			</div>

	
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Image SEO Meta Tag</label>
				<input class="onchers_common_form_input" name="data4" type="text" placeholder="" minlength="1" value="`+ data4 +`" required>
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Left Side Text</label>
				<input class="onchers_common_form_input" name="data1" type="text" placeholder="" minlength="1" value="`+ data1 +`" required>
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Right Side Text</label>
				<input class="onchers_common_form_input" name="data2" type="text" placeholder="" minlength="1" value="`+ data2 +`" required>
			</div>
	
	
			<div class="onchers_form_item_container">
				<input class="onchers_common_form_button" type="submit" value="Update">
			</div>
	
	
		</form>
	</div>
	
	`;
	return welcome_text_update_form;
}



function add_new_slider_function(){
	var welcome_text_update_form =
	`<div class="onchers_common_form_keeper">
		<form class="onchers_common_form" method="post" enctype="multipart/form-data"  action="forms/add_new_slider_item.php">
	
			
			<div class="onchers_common_form_header">
				<h2 class="onchers_common_form_heading">Add New Slider</h2>
			</div>


			<div class="onchers_form_item_container onchers_picture_center_keeper">
				<div class="onchers_form_item_picture">
					<img id="student_profile_pic_form" class="onchers_game_data_form_iamge" src="assets/image_not_inputed.jpg">
					<input type="file" "image/png, image/gif, image/jpeg, image/gif" name="fileToUpload" id="student_profile_input"  onchange="loadFile(event)" style="display: none;" required>
					<label class="image_input_label" for="student_profile_input" style="cursor: pointer;">Upload</label>
				</div>
			</div>

	
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Heading</label>
				<input class="onchers_common_form_input" name="data2" type="text" placeholder="" minlength="1" required>
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Short Description</label>
				<input class="onchers_common_form_input" name="data3" type="text" placeholder="" minlength="1" required>
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Button Text</label>
				<input class="onchers_common_form_input" name="data4" type="text" placeholder="" minlength="1" required>
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Button Href Link</label>
				<input class="onchers_common_form_input" name="data5" type="text" placeholder="" minlength="1" required>
			</div>
	
	
			<div class="onchers_form_item_container">
				<input class="onchers_common_form_button" type="submit" value="ADD">
			</div>
	
	
		</form>
	</div>
	
	`;
	return welcome_text_update_form;
}



function update_artist_statement(data1, data2, data3, data4){
	var welcome_text_update_form =
	`<div class="onchers_common_form_keeper">
		<form class="onchers_common_form" method="post" enctype="multipart/form-data"  action="forms/update_artist_statement.php">
	
			
			<div class="onchers_common_form_header">
				<h2 class="onchers_common_form_heading">Update Artist Statement</h2>
			</div>


			<div class="onchers_form_item_container onchers_picture_center_keeper">
				<div class="onchers_form_item_picture">
					<img id="student_profile_pic_form" src="../assets/official/`+ data3 +`">
					<input type="file" "image/png, image/gif, image/jpeg, image/gif" name="fileToUpload" id="student_profile_input"  onchange="loadFile(event)" style="display: none;">
					<label class="image_input_label" for="student_profile_input" style="cursor: pointer;">Upload</label>
				</div>
			</div>

	
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Image SEO Meta Tag</label>
				<input class="onchers_common_form_input" name="data4" type="text" placeholder="" minlength="1" value="`+ data4 +`" required>
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Heading</label>
				<input class="onchers_common_form_input" name="data1" type="text" placeholder="" minlength="1" value="`+ data1 +`" required>
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Description</label>
				<input class="onchers_common_form_input" name="data2" type="text" placeholder="" minlength="1" value="`+ data2 +`" required>
			</div>
	
	
			<div class="onchers_form_item_container">
				<input class="onchers_common_form_button" type="submit" value="Update">
			</div>
	
	
		</form>
	</div>
	
	`;
	return welcome_text_update_form;
}



function update_artist_section(data1, data2, data3){
	var welcome_text_update_form =
	`<div class="onchers_common_form_keeper">
		<form class="onchers_common_form" method="post" enctype="multipart/form-data"  action="forms/update_artist_section_meta.php">
	
			
			<div class="onchers_common_form_header">
				<h2 class="onchers_common_form_heading">Update Artist Section</h2>
			</div>

	
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Heading</label>
				<input class="onchers_common_form_input" name="data1" type="text" placeholder="" minlength="1" value="`+ data1 +`" required>
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Button Text</label>
				<input class="onchers_common_form_input" name="data2" type="text" placeholder="" minlength="1" value="`+ data2 +`" required>
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Button Link</label>
				<input class="onchers_common_form_input" name="data3" type="text" placeholder="" minlength="1" value="`+ data3 +`" required>
			</div>
	
	
			<div class="onchers_form_item_container">
				<input class="onchers_common_form_button" type="submit" value="Update">
			</div>
	
	
		</form>
	</div>
	
	`;
	return welcome_text_update_form;
}






function update_music_band_section(data1, data2, data3){
	var welcome_text_update_form =
	`<div class="onchers_common_form_keeper">
		<form class="onchers_common_form" method="post" enctype="multipart/form-data"  action="forms/update_music_band_section.php">
	
			
			<div class="onchers_common_form_header">
				<h2 class="onchers_common_form_heading">Update Music Band Section</h2>
			</div>


			<div class="onchers_form_item_container onchers_picture_center_keeper">
				<div class="onchers_form_item_picture">
					<img id="student_profile_pic_form" src="../assets/official/`+ data1 +`">
					<input type="file" "image/png, image/gif, image/jpeg, image/gif" name="fileToUpload" id="student_profile_input"  onchange="loadFile(event)" style="display: none;">
					<label class="image_input_label" for="student_profile_input" style="cursor: pointer;">Upload</label>
				</div>
			</div>

	
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Image Link</label>
				<input class="onchers_common_form_input" name="data3" type="url" placeholder="" minlength="1" value="`+ data3 +`">
			</div>
	
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Description</label>
				<textarea class="onchers_common_form_textarea" style="min-height: 200px;" name="data2" type="text"  placeholder="" required>`+ data2 +`</textarea>
			</div>
	
	
	
			<div class="onchers_form_item_container">
				<input class="onchers_common_form_button" type="submit" value="Update">
			</div>
	
	
		</form>
	</div>
	
	`;
	return welcome_text_update_form;
}




function update_graphx_central(data1, data2, data3){
	var welcome_text_update_form =
	`<div class="onchers_common_form_keeper">
		<form class="onchers_common_form" method="post" enctype="multipart/form-data"  action="forms/update_graphxcentral_section.php">
	
			
			<div class="onchers_common_form_header">
				<h2 class="onchers_common_form_heading">Update GraphXCentral Section</h2>
			</div>


			<div class="onchers_form_item_container onchers_picture_center_keeper">
				<div class="onchers_form_item_picture">
					<img id="student_profile_pic_form" src="../assets/official/`+ data1 +`">
					<input type="file" "image/png, image/gif, image/jpeg, image/gif" name="fileToUpload" id="student_profile_input"  onchange="loadFile(event)" style="display: none;">
					<label class="image_input_label" for="student_profile_input" style="cursor: pointer;">Upload</label>
				</div>
			</div>

	
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Url</label>
				<input class="onchers_common_form_input" name="data3" type="url" placeholder="" minlength="1" value="`+ data3 +`">
			</div>

	
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Button Text</label>
				<input class="onchers_common_form_input" name="data2" type="text" placeholder="" minlength="1" value="`+ data2 +`">
			</div>
	
	
	
			<div class="onchers_form_item_container">
				<input class="onchers_common_form_button" type="submit" value="Update">
			</div>
	
	
		</form>
	</div>
	
	`;
	return welcome_text_update_form;
}




function update_art_gallery_single_art(data1, data2, data3, data4, tagName){
	var welcome_text_update_form =
	`<div class="onchers_common_form_keeper">
		<form class="onchers_common_form" method="post" enctype="multipart/form-data"  action="forms/update_art_gallery_single_art.php">
	
			
			<div class="onchers_common_form_header">
				<h2 class="onchers_common_form_heading">Update GraphXCentral Section</h2>
			</div>

	
			<div class="onchers_form_item_container">
				<input class="onchers_common_form_input" name="tagName" type="hidden" placeholder="" minlength="1" value="`+ tagName +`" required="">
			</div>


			<div class="onchers_form_item_container onchers_picture_center_keeper">
				<div class="onchers_form_item_picture">
					<img id="student_profile_pic_form" src="../assets/artgallery/`+ data4 +`">
					<input type="file" "image/png, image/gif, image/jpeg, image/gif" name="fileToUpload" id="student_profile_input"  onchange="loadFile(event)" style="display: none;">
					<label class="image_input_label" for="student_profile_input" style="cursor: pointer;">Upload</label>
				</div>
			</div>

	
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Art Name</label>
				<input class="onchers_common_form_input" name="data1" type="text" placeholder="" minlength="1" value="`+ data1 +`" required="">
			</div>

	
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Offer Price</label>
				<input class="onchers_common_form_input" name="data2" type="number" placeholder="" minlength="1" value="`+ data2 +`"  required="">
			</div>

	
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Regular Price</label>
				<input class="onchers_common_form_input" name="data3" type="number" placeholder="" minlength="1" value="`+ data3 +`"  required="">
			</div>
	
	
	
			<div class="onchers_form_item_container">
				<input class="onchers_common_form_button" type="submit" value="Update">
			</div>
	
	
		</form>
	</div>
	
	`;
	return welcome_text_update_form;
}



function add_new_artist_slider_item(){
	var welcome_text_update_form =
	`<div class="onchers_common_form_keeper">
		<form class="onchers_common_form" method="post" enctype="multipart/form-data"  action="forms/add_new_artist_slider_item.php">
	
			
			<div class="onchers_common_form_header">
				<h2 class="onchers_common_form_heading">Add New Artist</h2>
			</div>


			<div class="onchers_form_item_container onchers_picture_center_keeper">
				<div class="onchers_form_item_picture">
					<img id="student_profile_pic_form" class="onchers_game_data_form_iamge" src="assets/image_not_inputed.jpg">
					<input type="file" "image/png, image/gif, image/jpeg, image/gif" name="fileToUpload" id="student_profile_input"  onchange="loadFile(event)" style="display: none;" required>
					<label class="image_input_label" for="student_profile_input" style="cursor: pointer;">Upload</label>
				</div>
			</div>

	
			<br>
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Image SEO Meta Text</label>
				<input class="onchers_common_form_input" name="data3" type="text" placeholder="" minlength="1" required>
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Artist Name</label>
				<input class="onchers_common_form_input" name="data1" type="text" placeholder="" minlength="1" required>
			</div>

	
			<div class="onchers_form_item_container">
				<input class="onchers_common_form_button" type="submit" value="ADD">
			</div>
	
	
		</form>
	</div>
	
	`;
	return welcome_text_update_form;
}



function add_new_art_for_sell(){
	var welcome_text_update_form =
	`<div class="onchers_common_form_keeper">
		<form class="onchers_common_form" method="post" enctype="multipart/form-data"  action="forms/add_new_art_piece.php">
	
			
			<div class="onchers_common_form_header">
				<h2 class="onchers_common_form_heading">Add New Art Piece</h2>
			</div>


			<div class="onchers_form_item_container onchers_picture_center_keeper">
				<div class="onchers_form_item_picture">
					<img id="student_profile_pic_form" class="onchers_game_data_form_iamge" src="assets/image_not_inputed.jpg">
					<input type="file" "image/png, image/gif, image/jpeg, image/gif" name="fileToUpload" id="student_profile_input"  onchange="loadFile(event)" style="display: none;" required>
					<label class="image_input_label" for="student_profile_input" style="cursor: pointer;">Upload</label>
				</div>
			</div>

	
			<br>
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Art Name</label>
				<input class="onchers_common_form_input" name="data1" type="text" placeholder="" minlength="1" required>
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Offer Price</label>
				<input class="onchers_common_form_input" name="data2" type="number" placeholder="" required>
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Regular Price</label>
				<input class="onchers_common_form_input" name="data3" type="number" placeholder="" required>
			</div>

	
			<div class="onchers_form_item_container">
				<input class="onchers_common_form_button" type="submit" value="ADD">
			</div>
	
	
		</form>
	</div>
	
	`;
	return welcome_text_update_form;
}


function update_music_section(data1, data2, data3){
	var welcome_text_update_form =
	`<div class="onchers_common_form_keeper">
		<form class="onchers_common_form" method="post" enctype="multipart/form-data"  action="forms/update_music_section_meta.php">
	
			
			<div class="onchers_common_form_header">
				<h2 class="onchers_common_form_heading">Update Artist Section</h2>
			</div>

	
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Heading</label>
				<input class="onchers_common_form_input" name="data1" type="text" placeholder="" minlength="1" value="`+ data1 +`" required>
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Button Text</label>
				<input class="onchers_common_form_input" name="data2" type="text" placeholder="" minlength="1" value="`+ data2 +`" required>
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Button Link</label>
				<input class="onchers_common_form_input" name="data3" type="text" placeholder="" minlength="1" value="`+ data3 +`" required>
			</div>
	
	
			<div class="onchers_form_item_container">
				<input class="onchers_common_form_button" type="submit" value="Update">
			</div>
	
	
		</form>
	</div>
	
	`;
	return welcome_text_update_form;
}



function add_new_music(){
	var welcome_text_update_form =
	`<div class="onchers_common_form_keeper">
		<form class="onchers_common_form" method="post" enctype="multipart/form-data"  action="forms/add_new_music.php">
	
			
			<div class="onchers_common_form_header">
				<h2 class="onchers_common_form_heading">Add New Music</h2>
			</div>


			<div class="onchers_form_item_container onchers_picture_center_keeper oncher_upload_another_file_form_item">
				<div class="onchers_form_item_picture">
					<img id="pdf_profile_input_form" class="upload_pdf_form_pic" src="assets/music_upload_sample.jpg">
					<input type="file" accept="image/png, image/gif, image/jpeg, image/gif" name="fileToUpload" id="pdf_profile_input" onchange="loadFilePDFUp(event)" style="display: none;" required>
					<label class="image_input_label image_input_label_pdf" for="pdf_profile_input" style="cursor: pointer;">Upload</label>
				</div>
			</div>

	
			<br>
			<!--<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Image SEO Meta Text</label>
				<input class="onchers_common_form_input" name="data3" type="text" placeholder="" minlength="1" required>
			</div>-->

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Music File</label>
				<input type="file" accept="*" name="pdffileToUpload" required>
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Spotify Album Url</label>
				<input class="onchers_common_form_input" name="data3" type="url" placeholder="" minlength="1" required>
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">iTunes Album Url</label>
				<input class="onchers_common_form_input" name="data4" type="url" placeholder="" minlength="1" required>
			</div>

	
			<div class="onchers_form_item_container">
				<input class="onchers_common_form_button" type="submit" value="UPLOAD">
			</div>
	
	
		</form>
	</div>
	
	`;
	return welcome_text_update_form;
}



function update_publishing_section(data1, data2, data3){
	var welcome_text_update_form =
	`<div class="onchers_common_form_keeper">
		<form class="onchers_common_form" method="post" enctype="multipart/form-data"  action="forms/update_publishing_section.php">
	
			
			<div class="onchers_common_form_header">
				<h2 class="onchers_common_form_heading">Update Publishing Section</h2>
			</div>


			<div class="onchers_form_item_container onchers_picture_center_keeper">
				<div class="onchers_form_item_picture">
					<img id="student_profile_pic_form" src="../assets/official/`+ data1 +`">
					<input type="file" "image/png, image/gif, image/jpeg, image/gif" name="fileToUpload" id="student_profile_input"  onchange="loadFile(event)" style="display: none;">
					<label class="image_input_label" for="student_profile_input" style="cursor: pointer;">Upload</label>
				</div>
			</div>

	
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Image SEO Meta Tag</label>
				<input class="onchers_common_form_input" name="data2" type="text" placeholder="" minlength="5" value="`+ data2 +`" required>
			</div>
	
			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Description</label>
				<textarea class="onchers_common_form_textarea" style="min-height: 200px;" name="data3" type="text"  placeholder="" required>`+ data3 +`</textarea>
			</div>
	
	
	
			<div class="onchers_form_item_container">
				<input class="onchers_common_form_button" type="submit" value="Update">
			</div>
	
	
		</form>
	</div>
	
	`;
	return welcome_text_update_form;
}

	
function add_new_book(){
	var welcome_text_update_form =
	`<div class="onchers_common_form_keeper">
		<form class="onchers_common_form" method="post" enctype="multipart/form-data"  action="forms/add_new_book.php">
	
			
			<div class="onchers_common_form_header">
				<h2 class="onchers_common_form_heading">Add New Book</h2>
			</div>


			<div class="onchers_form_item_container onchers_picture_center_keeper oncher_upload_another_file_form_item">
				<div class="onchers_form_item_picture">
					<img id="pdf_profile_input_form" class="upload_pdf_form_pic" src="assets/pdf_upload_sample.jpg">
					<input type="file" accept="image/png, image/gif, image/jpeg, image/gif" name="fileToUpload" id="pdf_profile_input" onchange="loadFilePDFUp(event)" style="display: none;" required>
					<label class="image_input_label image_input_label_pdf" for="pdf_profile_input" style="cursor: pointer;">Upload</label>
				</div>
			</div>

	
			<br>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">PDF File</label>
				<input type="file" accept="application/pdf" name="pdffileToUpload">
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Book URL</label>
				<input class="onchers_common_form_input" name="data3" type="url" placeholder="Optional">
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Title</label>
				<input class="onchers_common_form_input" name="data4" type="text" placeholder="" minlength="1" required="">
			</div>

			<div class="onchers_form_item_container">
				<label class="onchers_common_form_label">Release Date (Optional)</label>
				<input class="onchers_common_form_input" name="data5" type="date" placeholder=">
			</div>

	
			<div class="onchers_form_item_container">
				<input class="onchers_common_form_button" type="submit" value="UPLOAD">
			</div>
	
	
		</form>
	</div>
	
	`;
	return welcome_text_update_form;
}



const alert_box_window_students = document.getElementById("alert_box_window_students");
const alert_box_inside_students = document.getElementById("alert_box_inside_students");
const close_student_alert_box = document.getElementById("close_student_alert_box");


const closeTheModalStudent = () => { alert_box_window_students.style.display = "none"; };


const show_universal_student_modal = ( modalWidth, modalHeight, modalHTML, closeBtnTop, closeBtnLeft) => {
	alert_box_window_students.style.display = "block";

	alert_box_inside_students.style.width = modalWidth;
	alert_box_inside_students.style.height = modalHeight;


	alert_box_inside_students.innerHTML = modalHTML;


	alert_box_inside_students.innerHTML = alert_box_inside_students.innerHTML +
	`<p id="close_student_alert_box" onclick="closeTheModalStudent()"><span class="material-icons">cancel</span></p>`;
}




var loadFilePDFUp = function(event) {
	var image = document.getElementById('pdf_profile_input_form');
	image.src = URL.createObjectURL(event.target.files[0]);
};

