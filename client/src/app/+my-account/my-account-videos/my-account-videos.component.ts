import { from as observableFrom, Observable } from 'rxjs'
import { concatAll, tap } from 'rxjs/operators'
import { Component, OnDestroy, OnInit } from '@angular/core'
import { ActivatedRoute, Router } from '@angular/router'
import { Location } from '@angular/common'
import { immutableAssign } from '@app/shared/misc/utils'
import { ComponentPagination } from '@app/shared/rest/component-pagination.model'
import { NotificationsService } from 'angular2-notifications'
import { AuthService } from '../../core/auth'
import { ConfirmService } from '../../core/confirm'
import { AbstractVideoList } from '../../shared/video/abstract-video-list'
import { Video } from '../../shared/video/video.model'
import { VideoService } from '../../shared/video/video.service'
import { I18n } from '@ngx-translate/i18n-polyfill'
import { VideoState } from '../../../../../shared/models/videos'

@Component({
  selector: 'my-account-videos',
  templateUrl: './my-account-videos.component.html',
  styleUrls: [ './my-account-videos.component.scss' ]
})
export class MyAccountVideosComponent extends AbstractVideoList implements OnInit, OnDestroy {
  titlePage: string
  currentRoute = '/my-account/videos'
  checkedVideos: { [ id: number ]: boolean } = {}
  pagination: ComponentPagination = {
    currentPage: 1,
    itemsPerPage: 5,
    totalItems: null
  }

  protected baseVideoWidth = -1
  protected baseVideoHeight = 155

  constructor (
    protected router: Router,
    protected route: ActivatedRoute,
    protected authService: AuthService,
    protected notificationsService: NotificationsService,
    protected confirmService: ConfirmService,
    protected location: Location,
    protected i18n: I18n,
    private videoService: VideoService
  ) {
    super()

    this.titlePage = this.i18n('My videos')
  }

  ngOnInit () {
    super.ngOnInit()
  }

  ngOnDestroy () {
    super.ngOnDestroy()
  }

  abortSelectionMode () {
    this.checkedVideos = {}
  }

  isInSelectionMode () {
    return Object.keys(this.checkedVideos).some(k => this.checkedVideos[ k ] === true)
  }

  getVideosObservable (page: number) {
    const newPagination = immutableAssign(this.pagination, { currentPage: page })

    return this.videoService.getMyVideos(newPagination, this.sort)
  }

  generateSyndicationList () {
    throw new Error('Method not implemented.')
  }

  async deleteSelectedVideos () {
    const toDeleteVideosIds = Object.keys(this.checkedVideos)
                                    .filter(k => this.checkedVideos[ k ] === true)
                                    .map(k => parseInt(k, 10))

    const res = await this.confirmService.confirm(
      this.i18n('Do you really want to delete {{deleteLength}} videos?', { deleteLength: toDeleteVideosIds.length }),
      this.i18n('Delete')
    )
    if (res === false) return

    const observables: Observable<any>[] = []
    for (const videoId of toDeleteVideosIds) {
      const o = this.videoService.removeVideo(videoId)
                    .pipe(tap(() => this.spliceVideosById(videoId)))

      observables.push(o)
    }

    observableFrom(observables)
      .pipe(concatAll())
      .subscribe(
        res => {
          this.notificationsService.success(
            this.i18n('Success'),
            this.i18n('{{deleteLength}} videos deleted.', { deleteLength: toDeleteVideosIds.length })
          )

          this.abortSelectionMode()
          this.reloadVideos()
        },

        err => this.notificationsService.error(this.i18n('Error'), err.message)
      )
  }

  async deleteVideo (video: Video) {
    const res = await this.confirmService.confirm(
      this.i18n('Do you really want to delete {{videoName}}?', { videoName: video.name }),
      this.i18n('Delete')
    )
    if (res === false) return

    this.videoService.removeVideo(video.id)
        .subscribe(
          status => {
            this.notificationsService.success(
              this.i18n('Success'),
              this.i18n('Video {{videoName}} deleted.', { videoName: video.name })
            )
            this.reloadVideos()
          },

          error => this.notificationsService.error(this.i18n('Error'), error.message)
        )
  }

  getStateLabel (video: Video) {
    if (video.state.id === VideoState.PUBLISHED) return this.i18n('Published')

    if (video.state.id === VideoState.TO_TRANSCODE && video.waitTranscoding === true) return this.i18n('Waiting transcoding')
    if (video.state.id === VideoState.TO_TRANSCODE) return this.i18n('To transcode')

    return this.i18n('Unknown state')
  }

  protected buildVideoHeight () {
    // In account videos, the video height is fixed
    return this.baseVideoHeight
  }

  private spliceVideosById (id: number) {
    for (const key of Object.keys(this.loadedPages)) {
      const videos = this.loadedPages[ key ]
      const index = videos.findIndex(v => v.id === id)

      if (index !== -1) {
        videos.splice(index, 1)
        return
      }
    }
  }
}
